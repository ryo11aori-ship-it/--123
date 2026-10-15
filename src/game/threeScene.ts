/**
 * 3Dシーン (three.js)
 *
 * 物理は src/physics の自作シミュレータが担当する。
 *   1. roll() で投擲を「最後まで」シミュレーションして記録 (時間分割で UI を止めない)
 *   2. 記録を任意時刻でサンプリングして再生 (フレームレート非依存・スロー再生可)
 *   3. 衝突イベントを記録の時刻どおりに効果音へ流す
 *
 * お椀の形は物理と同じデータ(母線 + 凹凸マップ)から作っているので、
 * 見えている面とサイコロが当たる面は一致する。
 */
import * as THREE from 'three';
import { sound } from '../audio/soundManager';
import { buildBowlModel, BowlModel } from '../physics/bowlModel';
import { DICE_COUNT, STEP_HZ } from '../physics/constants';
import { Prng, entropyPool } from '../physics/rng';
import { Quality, RollJob } from '../physics/rollJob';
import { DiceWorld } from '../physics/world';
import { FLOATS_PER_DIE, RollMeta, RollOutcome, sampleRecording } from '../physics/recording';
import { CM, MeshData, buildBowlMeshes, buildDiceMesh, updateBowlInner } from '../render/meshes';
import { createDiceAtlas, createMatTexture, createTableTexture } from '../render/textures';

/** ゲーム仕様: ションベン(サイコロが椀外へ落ちる)の発生確率は1投擲あたり固定で1% */
export const SHONBEN_RATE = 0.01;

export interface SceneSettings {
  quality: Quality;
  /** お椀の凹凸の強さ (0=つるつる, 1=標準, 2=ざらざら) */
  bumpScale: number;
  /** 再生速度 (1=実時間, 0.5=スロー) */
  timeScale: number;
  /** 画面の明るさ */
  brightness: number;
}

export interface RollResult {
  values: number[];
  isShonben: boolean;
  outsideDice: number[];
  meta: RollMeta;
}

export const DEFAULT_SETTINGS: SceneSettings = {
  quality: 'medium',
  bumpScale: 1,
  timeScale: 0.8,
  brightness: 1,
};

const QUALITY_PRESETS: Record<Quality, { segments: number; shadow: number; dpr: number }> = {
  low: { segments: 192, shadow: 1024, dpr: 1.25 },
  medium: { segments: 288, shadow: 1536, dpr: 1.75 },
  high: { segments: 448, shadow: 2048, dpr: 2 },
};

const PREP_TIME = 0.75; // 持ち上げて振る時間 [s]
const HOLD_TIME = 0.55; // 静止後に結果を見せる時間 [s]
const SIM_SLICE_MS = 7; // 1フレームあたり物理計算に使う時間

type Phase = 'idle' | 'prep' | 'play' | 'hold';

const easeInOut = (t: number): number => t * t * (3 - 2 * t);

function toGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  if (m.colors) g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  return g;
}

export class ThreeSceneManager {
  private container: HTMLElement;
  private settings: SceneSettings;

  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 1, 500);
  private spot: THREE.SpotLight | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastTime = 0;
  private destroyed = false;

  // 物理
  readonly bowl: BowlModel;
  private world: DiceWorld;

  // メッシュ
  private diceMeshes: THREE.Mesh[] = [];
  private innerData: MeshData | null = null;
  private innerGeo: THREE.BufferGeometry | null = null;
  private disposables: { dispose(): void }[] = [];

  // 姿勢 (px,py,pz, qx,qy,qz,qw) × 5  [m]
  private restPose = new Float32Array(DICE_COUNT * FLOATS_PER_DIE);
  private pose = new Float32Array(DICE_COUNT * FLOATS_PER_DIE);
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();

  // 投擲の状態
  private phase: Phase = 'idle';
  private job: RollJob | null = null;
  private outcome: RollOutcome | null = null;
  private phaseTime = 0;
  private readyAt = -1; // 計算が完了した prep 内の時刻
  private playTime = 0;
  private eventCursor = 0;
  private resolveRoll: ((r: RollResult) => void) | null = null;
  private rejectRoll: ((e: Error) => void) | null = null;
  private headless = false;
  private resetTimer = 0;

  /** 物理ログ表示用: 投擲の統計が決まるたびに呼ばれる (投擲開始時は null) */
  onStats: ((meta: RollMeta | null) => void) | null = null;

  // カメラ
  private rig = { az: 0, pol: 0.82, dist: 31 };
  private rigGoal = { az: 0, pol: 0.82, dist: 31 };
  private focus = new THREE.Vector3(0, 2.5, 0);
  private focusGoal = new THREE.Vector3(0, 2.5, 0);
  private userInteractedAt = -1e9;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchStart = 0;
  private time = 0;

  constructor(container: HTMLElement, settings: Partial<SceneSettings> = {}) {
    this.container = container;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    const seed = entropyPool.seed();
    this.bowl = buildBowlModel(seed);
    this.bowl.bumpScale = this.settings.bumpScale;
    this.world = new DiceWorld(this.bowl, STEP_HZ[this.settings.quality]);

    try {
      this.initRenderer();
      this.buildScene();
    } catch (e) {
      // WebGL が使えない環境でもゲーム自体は遊べるようにする (物理だけ動かす)
      console.warn('3D描画を初期化できませんでした。物理計算のみで続行します:', e);
      this.headless = true;
      if (this.renderer) {
        this.renderer.domElement.remove();
        this.renderer.dispose();
      }
      this.renderer = null;
      const msg = document.createElement('div');
      msg.textContent = 'この環境では 3D 表示を利用できません (WebGL未対応)。ゲームは続行できます。';
      msg.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#a8a29e;font-size:14px;padding:24px;text-align:center';
      container.appendChild(msg);
    }
    this.settleInitialDice();
    this.applyPose(this.restPose);
    if (!this.headless) {
      this.lastTime = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  // -------------------------------------------------------------------
  //  初期化
  // -------------------------------------------------------------------
  private initRenderer(): void {
    const q = QUALITY_PRESETS[this.settings.quality];
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.settings.brightness;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';
    this.container.appendChild(renderer.domElement);

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);

    const el = renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private buildScene(): void {
    const q = QUALITY_PRESETS[this.settings.quality];
    const scene = this.scene;
    scene.background = new THREE.Color(0x07070a);
    scene.fog = new THREE.FogExp2(0x07070a, 0.0105);

    // --- 環境(反射)マップ: 柔らかい面光源を数枚置いた簡易スタジオ ---
    try {
      const env = new THREE.Scene();
      env.add(
        new THREE.Mesh(
          new THREE.SphereGeometry(50, 24, 16),
          new THREE.MeshBasicMaterial({ color: 0x0b0c14, side: THREE.BackSide }),
        ),
      );
      const panel = (w: number, h: number, c: THREE.Color, x: number, y: number, z: number) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
        m.position.set(x, y, z);
        m.lookAt(0, 0, 0);
        env.add(m);
      };
      panel(30, 30, new THREE.Color(6, 5.4, 4.4), 0, 40, 0);
      panel(14, 40, new THREE.Color(2.2, 2.0, 1.8), -38, 14, 10);
      panel(14, 40, new THREE.Color(1.1, 1.3, 2.0), 38, 14, -8);
      panel(40, 8, new THREE.Color(1.6, 1.4, 1.1), 0, 8, 40);
      const pmrem = new THREE.PMREMGenerator(this.renderer as THREE.WebGLRenderer);
      const rt = pmrem.fromScene(env, 0.04);
      scene.environment = rt.texture;
      scene.environmentIntensity = 0.85;
      this.disposables.push(rt, pmrem);
      env.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (m.material as THREE.Material).dispose();
      });
    } catch (e) {
      console.warn('環境マップを作れませんでした (反射なしで続行):', e);
    }

    // --- ライト ---
    scene.add(new THREE.HemisphereLight(0x9fb0ff, 0x2a1a10, 0.35));
    const spot = new THREE.SpotLight(0xfff0d8, 3.4, 0, 0.62, 0.85, 0);
    spot.position.set(5, 38, 7);
    spot.target.position.set(0, 2, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(q.shadow, q.shadow);
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.04;
    spot.shadow.camera.near = 12;
    spot.shadow.camera.far = 80;
    scene.add(spot, spot.target);
    this.spot = spot;
    const rimLight = new THREE.DirectionalLight(0xffc890, 0.9);
    rimLight.position.set(-18, 14, -22);
    scene.add(rimLight);
    const fill = new THREE.DirectionalLight(0x7a8cff, 0.45);
    fill.position.set(20, 10, 24);
    scene.add(fill);

    // --- 机と毛氈 ---
    const tableTex = new THREE.CanvasTexture(createTableTexture(1024));
    tableTex.colorSpace = THREE.SRGBColorSpace;
    tableTex.wrapS = THREE.RepeatWrapping;
    tableTex.wrapT = THREE.RepeatWrapping;
    tableTex.repeat.set(5, 5);
    tableTex.anisotropy = 4;
    const tableMat = new THREE.MeshStandardMaterial({ map: tableTex, roughness: 0.5, metalness: 0 });
    const table = new THREE.Mesh(new THREE.CircleGeometry(90, 96), tableMat);
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    scene.add(table);

    const matTex = new THREE.CanvasTexture(createMatTexture(1024));
    matTex.colorSpace = THREE.SRGBColorSpace;
    matTex.anisotropy = 4;
    const matMat = new THREE.MeshStandardMaterial({
      map: matTex,
      roughness: 0.95,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mat = new THREE.Mesh(new THREE.CircleGeometry(21, 96), matMat);
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = 0.02;
    mat.receiveShadow = true;
    scene.add(mat);
    this.disposables.push(tableTex, tableMat, matTex, matMat, table.geometry, mat.geometry);

    // --- お椀 (物理と同じデータから) ---
    const meshes = buildBowlMeshes(this.bowl, { segments: q.segments });
    this.innerData = meshes.inner;
    const innerGeo = toGeometry(meshes.inner);
    this.innerGeo = innerGeo;
    const glaze = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.24,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    });
    const inner = new THREE.Mesh(innerGeo, glaze);
    inner.castShadow = true;
    inner.receiveShadow = true;
    const outerGeo = toGeometry(meshes.outer);
    const outerMat = new THREE.MeshPhysicalMaterial({
      color: 0x15161c,
      roughness: 0.3,
      metalness: 0,
      clearcoat: 0.8,
      clearcoatRoughness: 0.12,
    });
    const outer = new THREE.Mesh(outerGeo, outerMat);
    outer.castShadow = true;
    outer.receiveShadow = true;
    const rimGeo = toGeometry(meshes.rim);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xd9ab4a, metalness: 1, roughness: 0.28 });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.castShadow = true;
    scene.add(inner, outer, rim);
    this.disposables.push(innerGeo, outerGeo, rimGeo, glaze, outerMat, rimMat);

    // --- サイコロ ---
    const atlas = new THREE.CanvasTexture(createDiceAtlas(512));
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.anisotropy = 8;
    const diceGeo = toGeometry(buildDiceMesh());
    const diceMat = new THREE.MeshPhysicalMaterial({
      map: atlas,
      roughness: 0.32,
      metalness: 0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.14,
    });
    for (let i = 0; i < DICE_COUNT; i++) {
      const m = new THREE.Mesh(diceGeo, diceMat);
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      this.diceMeshes.push(m);
    }
    this.disposables.push(atlas, diceGeo, diceMat);
    this.resetCamera(true);
  }

  /** 起動直後のサイコロ: 実際に物理で椀の底へ落として止める (お椀の外/床下には出ない) */
  private settleInitialDice(): void {
    const job = new RollJob(this.bowl, entropyPool.seed(), { wantShonben: false, quality: this.settings.quality }, this.world);
    const out = job.runToEnd();
    const rec = out.recording;
    const last = (rec.frameCount - 1) * DICE_COUNT * FLOATS_PER_DIE;
    this.restPose.set(rec.frames.subarray(last, last + DICE_COUNT * FLOATS_PER_DIE));
  }

  // -------------------------------------------------------------------
  //  公開API
  // -------------------------------------------------------------------
  setSettings(patch: Partial<SceneSettings>): void {
    const prev = this.settings;
    this.settings = { ...prev, ...patch };
    if (patch.bumpScale !== undefined && patch.bumpScale !== prev.bumpScale) {
      this.bowl.bumpScale = patch.bumpScale;
      if (this.innerData && this.innerGeo) {
        updateBowlInner(this.bowl, this.innerData, QUALITY_PRESETS[prev.quality].segments);
        (this.innerGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        (this.innerGeo.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
      }
    }
    if (patch.brightness !== undefined && this.renderer) this.renderer.toneMappingExposure = patch.brightness;
    if (patch.quality !== undefined && patch.quality !== prev.quality && this.phase === 'idle') {
      // 物理ステップ数は次の投擲から反映。描画品質(影・メッシュ密度)の変更は再読み込みで反映される。
      this.world = new DiceWorld(this.bowl, STEP_HZ[patch.quality]);
    }
  }

  getSettings(): SceneSettings {
    return { ...this.settings };
  }

  resetCamera(immediate = false): void {
    this.rigGoal = { az: 0, pol: 0.82, dist: this.defaultDist() };
    this.focusGoal.set(0, 2.5, 0);
    if (immediate) {
      this.rig = { ...this.rigGoal };
      this.focus.copy(this.focusGoal);
    }
  }

  /**
   * サイコロを振る。
   * 物理シミュレーションで目を決めて、記録を再生する。解決値は従来どおり { values, isShonben } を含む。
   */
  roll(): Promise<RollResult> {
    if (this.phase !== 'idle' || this.destroyed) return Promise.reject(new Error('Already rolling'));

    // 乱数: 暗号論的乱数 + 操作タイミングの揺らぎ。ションベンは仕様どおり固定 1%
    entropyPool.feed(performance.now());
    const pre = new Prng(entropyPool.seed());
    const wantShonben = pre.float() < SHONBEN_RATE;
    const jobSeed: [number, number, number, number] = [pre.nextU32(), pre.nextU32(), pre.nextU32(), pre.nextU32()];
    this.job = new RollJob(this.bowl, jobSeed, { wantShonben, quality: this.settings.quality }, this.world);
    this.outcome = null;
    this.phase = 'prep';
    this.phaseTime = 0;
    this.readyAt = -1;
    window.clearTimeout(this.resetTimer);
    this.onStats?.(null);
    sound.playWhoosh();

    return new Promise<RollResult>((resolve, reject) => {
      this.resolveRoll = resolve;
      this.rejectRoll = reject;
      if (this.headless) this.runHeadless();
    });
  }

  /** 描画なしで進める (WebGL 未対応環境用) */
  private runHeadless(): void {
    const job = this.job;
    if (!job) return;
    const out = job.runToEnd();
    this.outcome = out;
    this.onStats?.(out.meta);
    window.setTimeout(() => this.finishRoll(), 1200);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.resetTimer);
    this.resizeObserver?.disconnect();
    if (this.renderer) {
      const el = this.renderer.domElement;
      el.removeEventListener('pointerdown', this.onPointerDown);
      el.removeEventListener('pointermove', this.onPointerMove);
      el.removeEventListener('pointerup', this.onPointerUp);
      el.removeEventListener('pointercancel', this.onPointerUp);
      el.removeEventListener('wheel', this.onWheel);
      el.remove();
    }
    this.rejectRoll?.(new Error('destroyed'));
    this.rejectRoll = null;
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* 破棄の失敗は無視 */
      }
    }
    this.renderer?.dispose();
    this.renderer = null;
  }

  // -------------------------------------------------------------------
  //  フレーム更新
  // -------------------------------------------------------------------
  private tick = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.time += dt;
    this.update(dt);
    this.renderer?.render(this.scene, this.camera);
  };

  private update(dt: number): void {
    switch (this.phase) {
      case 'prep':
        this.updatePrep(dt);
        break;
      case 'play':
        this.updatePlay(dt);
        break;
      case 'hold':
        this.phaseTime += dt;
        if (this.phaseTime >= HOLD_TIME) this.finishRoll();
        break;
      default:
        break;
    }
    this.updateCamera(dt);
    // 吊り灯のごく緩やかな揺らぎ
    if (this.spot) this.spot.intensity = 3.4 * (1 + 0.012 * Math.sin(this.time * 1.7) + 0.006 * Math.sin(this.time * 5.3));
  }

  /** 持ち上げて振る。物理計算は演出の裏で時間分割して進める */
  private updatePrep(dt: number): void {
    this.phaseTime += dt;
    const job = this.job;
    if (job && !job.done) job.advance(SIM_SLICE_MS);
    if (job && job.done && this.readyAt < 0) {
      this.readyAt = this.phaseTime;
      this.outcome = job.outcome;
      if (this.outcome) this.onStats?.(this.outcome.meta);
    }

    const spec = this.outcome ? this.outcome.throwSpec : null;
    // 計算完了までは手元でカラカラ鳴らして待つ。完了してから持ち上げて投擲位置へ
    const s = spec ? Math.min(1, (this.phaseTime - this.readyAt) / PREP_TIME) : 0;
    const e = easeInOut(s);
    const rattle = spec ? (s > 0.3 ? 1 : 0.4) : 0.4;
    const wob = Math.sin(this.time * 63);
    for (let i = 0; i < DICE_COUNT; i++) {
      const o = i * FLOATS_PER_DIE;
      const rx = this.restPose[o];
      const ry = this.restPose[o + 1];
      const rz = this.restPose[o + 2];
      const tx = spec ? spec.dice[i].p[0] : rx;
      const ty = spec ? spec.dice[i].p[1] : ry;
      const tz = spec ? spec.dice[i].p[2] : rz;
      const decay = 1 - s; // 投擲位置に着くころには揺れがおさまる
      const j = 0.0028 * rattle * decay;
      const lift = Math.sin(Math.PI * e) * 0.014;
      this.pose[o] = rx + (tx - rx) * e + j * wob * Math.cos(i * 2.1);
      this.pose[o + 1] = ry + (ty - ry) * e + lift + j * 0.6 * Math.sin(this.time * 71 + i);
      this.pose[o + 2] = rz + (tz - rz) * e + j * wob * Math.sin(i * 1.7);
      this.qa.set(this.restPose[o + 3], this.restPose[o + 4], this.restPose[o + 5], this.restPose[o + 6]);
      if (spec) {
        const q = spec.dice[i].q;
        this.qb.set(q[0], q[1], q[2], q[3]);
        this.qa.slerp(this.qb, e);
      }
      this.pose[o + 3] = this.qa.x;
      this.pose[o + 4] = this.qa.y;
      this.pose[o + 5] = this.qa.z;
      this.pose[o + 6] = this.qa.w;
    }
    this.applyPose(this.pose);
    if (Math.floor(this.phaseTime * 15) !== Math.floor((this.phaseTime - dt) * 15)) {
      sound.playDiceHit((0.1 + 0.16 * rattle) * (0.6 + 0.4 * Math.abs(wob)));
    }

    if (spec && s >= 1) {
      this.phase = 'play';
      this.playTime = 0;
      this.eventCursor = 0;
      this.applyRecording(0);
    }
  }

  private updatePlay(dt: number): void {
    const out = this.outcome;
    if (!out) return;
    const rec = out.recording;
    this.playTime += dt * this.settings.timeScale;
    const t = this.playTime;
    this.applyRecording(t);

    // 衝突イベント → 効果音 (記録の時刻どおり)
    let played = 0;
    while (this.eventCursor < rec.events.length && rec.events[this.eventCursor].t <= t) {
      const e = rec.events[this.eventCursor++];
      if (played < 6 && t - e.t < 0.12) {
        sound.playImpact(e.kind, e.intensity, Math.max(-1, Math.min(1, (e.x * CM) / 12)));
        played++;
      }
    }

    this.frameDice(false);
    if (t >= rec.duration) {
      this.phase = 'hold';
      this.phaseTime = 0;
      this.frameDice(true);
      const last = (rec.frameCount - 1) * DICE_COUNT * FLOATS_PER_DIE;
      this.restPose.set(rec.frames.subarray(last, last + DICE_COUNT * FLOATS_PER_DIE));
    }
  }

  private applyRecording(t: number): void {
    if (!this.outcome) return;
    sampleRecording(this.outcome.recording, t, this.pose);
    this.applyPose(this.pose);
  }

  private applyPose(p: Float32Array | Float64Array): void {
    for (let i = 0; i < DICE_COUNT; i++) {
      const o = i * FLOATS_PER_DIE;
      const m = this.diceMeshes[i];
      if (!m) continue;
      m.position.set(p[o] * CM, p[o + 1] * CM, p[o + 2] * CM);
      m.quaternion.set(p[o + 3], p[o + 4], p[o + 5], p[o + 6]);
    }
  }

  private finishRoll(): void {
    const out = this.outcome;
    this.phase = 'idle';
    this.job = null;
    const resolve = this.resolveRoll;
    this.resolveRoll = null;
    this.rejectRoll = null;
    if (out) {
      const last = (out.recording.frameCount - 1) * DICE_COUNT * FLOATS_PER_DIE;
      this.restPose.set(out.recording.frames.subarray(last, last + DICE_COUNT * FLOATS_PER_DIE));
    }
    if (out && resolve) {
      sound.playBowlThud();
      resolve({ values: out.values, isShonben: out.shonben, outsideDice: out.outsideDice, meta: out.meta });
    }
    // 結果を見せたあと、カメラは標準位置へ戻る
    this.resetTimer = window.setTimeout(() => {
      if (this.phase === 'idle') this.resetCamera();
    }, 1500);
  }

  // -------------------------------------------------------------------
  //  カメラ
  // -------------------------------------------------------------------
  private defaultDist(): number {
    const aspect = this.camera.aspect || 1.6;
    // 縦長画面ではお椀(直径約18cm)が横に収まるよう距離を取る
    return 31 * Math.max(1, 1.05 / aspect);
  }

  /** サイコロ全体を画面に収める (椀の外へ出た賽がいても映す) */
  private frameDice(settled: boolean): void {
    if (this.time - this.userInteractedAt <= 4) return; // ユーザーが操作中は自動追従しない
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < DICE_COUNT; i++) {
      const o = i * FLOATS_PER_DIE;
      cx += this.pose[o] * CM;
      cy += this.pose[o + 1] * CM;
      cz += this.pose[o + 2] * CM;
    }
    cx /= DICE_COUNT;
    cy /= DICE_COUNT;
    cz /= DICE_COUNT;
    let maxR = 0;
    for (let i = 0; i < DICE_COUNT; i++) {
      const o = i * FLOATS_PER_DIE;
      maxR = Math.max(maxR, Math.hypot(this.pose[o] * CM - cx, this.pose[o + 2] * CM - cz));
    }
    const base = this.defaultDist();
    const spread = Math.max(0, maxR - 6);
    if (settled) {
      this.focusGoal.set(cx * 0.7, Math.max(1.5, cy * 0.5), cz * 0.7);
      this.rigGoal.dist = Math.max(base * 0.78, 14 + spread * 1.5);
    } else {
      this.focusGoal.set(cx * 0.25, 2.5 + cy * 0.12, cz * 0.25);
      this.rigGoal.dist = Math.max(base * 0.92, 16 + spread * 1.2);
    }
  }

  private updateCamera(dt: number): void {
    const k = 1 - Math.exp(-dt * 4.5);
    this.rig.az += (this.rigGoal.az - this.rig.az) * k;
    this.rig.pol += (this.rigGoal.pol - this.rig.pol) * k;
    this.rig.dist += (this.rigGoal.dist - this.rig.dist) * k;
    this.focus.lerp(this.focusGoal, k);
    // 静止中はごくわずかに呼吸するように揺らす
    const sway = this.phase === 'idle' ? 0.018 : 0;
    const az = this.rig.az + sway * Math.sin(this.time * 0.35);
    const pol = this.rig.pol + sway * 0.6 * Math.sin(this.time * 0.27 + 1);
    const sp = Math.sin(pol);
    this.camera.position.set(
      this.focus.x + this.rig.dist * sp * Math.sin(az),
      this.focus.y + this.rig.dist * Math.cos(pol),
      this.focus.z + this.rig.dist * sp * Math.cos(az),
    );
    this.camera.lookAt(this.focus);
  }

  private resize(): void {
    if (!this.renderer) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.phase === 'idle') this.rigGoal.dist = this.defaultDist();
  }

  // -------------------------------------------------------------------
  //  操作 (ドラッグで回転 / ホイール・ピンチでズーム)
  // -------------------------------------------------------------------
  private onPointerDown = (e: PointerEvent): void => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      /* キャプチャできなくても操作は続行 */
    }
    this.userInteractedAt = this.time;
    entropyPool.feed(e.clientX, e.clientY, performance.now());
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    this.userInteractedAt = this.time;
    entropyPool.feed(dx, dy, performance.now());
    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchStart > 0 && d > 0) this.zoom(this.pinchStart / d);
      this.pinchStart = d;
      return;
    }
    this.rigGoal.az -= dx * 0.006;
    this.rigGoal.pol = THREE.MathUtils.clamp(this.rigGoal.pol - dy * 0.005, 0.18, 1.42);
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.pinchStart = 0;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.userInteractedAt = this.time;
    this.zoom(Math.exp(e.deltaY * 0.0012));
  };

  private zoom(factor: number): void {
    this.rigGoal.dist = THREE.MathUtils.clamp(this.rigGoal.dist * factor, 14, 70);
  }
}
