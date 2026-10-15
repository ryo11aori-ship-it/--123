class SoundManager {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;

  constructor() {
    // AudioContext will be initialized on first user interaction
  }

  private initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  public setMuted(muted: boolean) {
    this.isMuted = muted;
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    return this.isMuted;
  }

  /**
   * UI Click
   */
  public playClick() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(300, now + 0.05);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.05);
  }

  /**
   * サイコロ投擲の風切り音
   */
  public playWhoosh() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const bufferSize = this.ctx.sampleRate * 0.25;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    const now = this.ctx.currentTime;
    filter.frequency.setValueAtTime(400, now);
    filter.frequency.exponentialRampToValueAtTime(1200, now + 0.12);
    filter.frequency.exponentialRampToValueAtTime(300, now + 0.25);
    filter.Q.value = 3.0;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    noise.start(now);
  }

  /**
   * サイコロ同士や椀底の衝突音 (カチッ、カラッ)
   */
  public playDiceHit(intensity = 1.0) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    // 硬質な骨/樹脂賽の衝突高周波
    const baseFreq = 1800 + Math.random() * 1000;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.4, now + 0.04);

    const vol = Math.min(0.2, 0.06 * intensity);
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.04);
  }

  /**
   * 物理シミュレーションの衝突イベント用の効果音 (モーダル合成)
   *  kind: 0=椀の内側(陶器) / 1=サイコロ同士 / 2=机 / 3=椀の縁
   *  intensity: 接触点での接近速度 [m/s] (0.1〜4程度)。強いほど大きく・明るい音
   *  pan: -1(左)〜1(右)。衝突位置から決める
   */
  public playImpact(kind: number, intensity: number, pan = 0) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const v = Math.max(0, Math.min(1, intensity / 3.2));
    const loud = 0.025 + 0.2 * Math.pow(v, 0.8);

    // 材質ごとの共鳴モード [周波数Hz, 相対振幅, 減衰秒]
    const modes: [number, number, number][] =
      kind === 0
        ? [[2150, 1, 0.09], [3480, 0.55, 0.06], [5200, 0.25, 0.04], [1180, 0.45, 0.12]] // 釉薬の陶器: 高く澄んだ「カラン」
        : kind === 1
          ? [[2750, 1, 0.035], [4300, 0.5, 0.025], [1600, 0.35, 0.05]] // 樹脂どうし: 乾いた「コツ」
          : kind === 3
            ? [[3050, 1, 0.12], [4900, 0.6, 0.08], [1450, 0.4, 0.15]] // 金縁: 少し金属的
            : [[760, 1, 0.05], [1350, 0.5, 0.035], [420, 0.5, 0.07]]; // 木の机: 鈍い「コトッ」
    const detune = 0.94 + Math.random() * 0.12;

    const out = ctx.createGain();
    out.gain.value = 1;
    let node: AudioNode = out;
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan)) * 0.7;
      out.connect(panner);
      node = panner;
    }
    node.connect(ctx.destination);

    for (const [f, a, d] of modes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f * detune * (1 + 0.15 * v), now);
      const peak = loud * a * (kind === 1 ? 0.8 : 1);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(peak, now + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + d * (0.6 + 0.8 * v));
      osc.connect(g);
      g.connect(out);
      osc.start(now);
      osc.stop(now + d * 1.6 + 0.02);
    }

    // 接触の瞬間のノイズ「ピシッ」
    const len = Math.floor(ctx.sampleRate * 0.012);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const ng = ctx.createGain();
    ng.gain.value = loud * 0.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = kind === 2 ? 900 : 3000;
    src.connect(hp);
    hp.connect(ng);
    ng.connect(out);
    src.start(now);
  }

  /**
   * 椀の鈍い低音衝突 (コトン)
   */
  public playBowlThud() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.1);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.1);
  }

  /**
   * 役確定時の和太鼓・勝利ジングル
   */
  public playWin(tier: 'god' | 'high' | 'normal') {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;

    // 和太鼓のドン！
    const drum = this.ctx.createOscillator();
    const drumGain = this.ctx.createGain();
    drum.type = 'sine';
    drum.frequency.setValueAtTime(140, now);
    drum.frequency.exponentialRampToValueAtTime(45, now + 0.35);

    drumGain.gain.setValueAtTime(0.4, now);
    drumGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    drum.connect(drumGain);
    drumGain.connect(this.ctx.destination);
    drum.start(now);
    drum.stop(now + 0.35);

    // 高位役（ピンゾロ・アラシ）の輝かしい鐘・ゴング和音
    const freqs = tier === 'god' ? [523.25, 659.25, 783.99, 1046.5] : [440, 554.37, 659.25];
    freqs.forEach((freq, idx) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      const delay = now + 0.1 + idx * 0.08;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, delay);

      gain.gain.setValueAtTime(0, delay);
      gain.gain.linearRampToValueAtTime(0.15, delay + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, delay + 0.8);

      osc.connect(gain);
      gain.connect(this.ctx!.destination);

      osc.start(delay);
      osc.stop(delay + 0.8);
    });
  }

  /**
   * ションベン・ヒフミの残念音（拍子木＋低音沈降）
   */
  public playLose() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    // 拍子木のカンッ
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(300, now + 0.12);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.12);

    // 重い低音ドゥーン
    const subOsc = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    subOsc.type = 'sawtooth';
    subOsc.frequency.setValueAtTime(110, now + 0.1);
    subOsc.frequency.exponentialRampToValueAtTime(40, now + 0.5);

    subGain.gain.setValueAtTime(0.18, now + 0.1);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    subOsc.connect(subGain);
    subGain.connect(this.ctx.destination);

    subOsc.start(now + 0.1);
    subOsc.stop(now + 0.5);
  }
}

export const sound = new SoundManager();
