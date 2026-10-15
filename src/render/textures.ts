/**
 * Canvas で描くテクスチャ (画像ファイル不要)
 */
import { DICE_FACES, pipLayout } from './meshes';

function makeCanvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas が使えません');
  return { c, g };
}

/** 決定的な疑似乱数 (見た目用) */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * サイコロのアトラス (3×2)。面の順は DICE_FACES と同じ。
 * 象牙色の地に、1 と 4 は朱、他は墨色の目。くぼみの形は meshes.ts の pipLayout と共通。
 */
export function createDiceAtlas(cell = 512): HTMLCanvasElement {
  const { c, g } = makeCanvas(cell * 3, cell * 2);
  const rnd = lcg(7);
  DICE_FACES.forEach((face, fi) => {
    const col = fi % 3;
    const row = Math.floor(fi / 3);
    const x0 = col * cell;
    const y0 = row * cell;
    // 地: ごく淡い象牙のグラデーション
    const grad = g.createRadialGradient(x0 + cell * 0.45, y0 + cell * 0.4, cell * 0.1, x0 + cell / 2, y0 + cell / 2, cell * 0.75);
    grad.addColorStop(0, '#f7efd9');
    grad.addColorStop(1, '#e8dcbc');
    g.fillStyle = grad;
    g.fillRect(x0, y0, cell, cell);
    // 微細なムラ
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(120,95,50,${0.012 + rnd() * 0.02})`;
      const r = 2 + rnd() * 9;
      g.beginPath();
      g.arc(x0 + rnd() * cell, y0 + rnd() * cell, r, 0, Math.PI * 2);
      g.fill();
    }
    const red = face.pips === 1 || face.pips === 4;
    for (const p of pipLayout(face.pips)) {
      const cx = x0 + (p.x * 0.5 + 0.5) * cell;
      const cy = y0 + (1 - (p.y * 0.5 + 0.5)) * cell;
      const rad = p.r * 0.5 * cell;
      const pg = g.createRadialGradient(cx - rad * 0.25, cy - rad * 0.3, rad * 0.1, cx, cy, rad);
      if (red) {
        pg.addColorStop(0, '#e0323a');
        pg.addColorStop(0.75, '#b3121c');
        pg.addColorStop(1, '#8a0c14');
      } else {
        pg.addColorStop(0, '#2a2a32');
        pg.addColorStop(0.75, '#111116');
        pg.addColorStop(1, '#050507');
      }
      g.fillStyle = pg;
      g.beginPath();
      g.arc(cx, cy, rad * 1.02, 0, Math.PI * 2);
      g.fill();
    }
  });
  return c;
}

/** 机: 黒漆に近い深い木目 */
export function createTableTexture(size = 1024): HTMLCanvasElement {
  const { c, g } = makeCanvas(size, size);
  const rnd = lcg(11);
  g.fillStyle = '#1a110c';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 360; i++) {
    const y = rnd() * size;
    const amp = 2 + rnd() * 10;
    const freq = 0.002 + rnd() * 0.006;
    const ph = rnd() * 6.28;
    const a = 0.03 + rnd() * 0.12;
    g.strokeStyle = rnd() < 0.5 ? `rgba(70,42,24,${a})` : `rgba(5,3,2,${a * 1.6})`;
    g.lineWidth = 0.6 + rnd() * 2.6;
    g.beginPath();
    for (let x = 0; x <= size; x += 16) {
      const yy = y + Math.sin(x * freq + ph) * amp;
      if (x === 0) g.moveTo(x, yy);
      else g.lineTo(x, yy);
    }
    g.stroke();
  }
  return c;
}

/** お椀の下に敷く丸い毛氈 (深い藍) と金の二重線 */
export function createMatTexture(size = 1024): HTMLCanvasElement {
  const { c, g } = makeCanvas(size, size);
  const rnd = lcg(23);
  const mid = size / 2;
  const grad = g.createRadialGradient(mid, mid, size * 0.05, mid, mid, mid);
  grad.addColorStop(0, '#141d33');
  grad.addColorStop(0.7, '#0e1627');
  grad.addColorStop(1, '#0a101d');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // 毛氈の繊維
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(${150 + rnd() * 80},${160 + rnd() * 70},${200 + rnd() * 50},${0.012 + rnd() * 0.02})`;
    g.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  // 青海波(せいがいは)をうっすらと
  g.strokeStyle = 'rgba(190,160,90,0.07)';
  g.lineWidth = 2;
  const R = size * 0.052;
  for (let row = 0; row < 22; row++) {
    for (let col = -1; col < 22; col++) {
      const cx = col * R * 2 + (row % 2) * R;
      const cy = row * R * 0.95 + R * 1.5;
      for (let k = 1; k <= 3; k++) {
        g.beginPath();
        g.arc(cx, cy, (R * k) / 3, Math.PI, 0);
        g.stroke();
      }
    }
  }
  // 金の二重線
  for (const [r, w, a] of [
    [0.472, 5, 0.85],
    [0.455, 2, 0.6],
  ] as const) {
    g.strokeStyle = `rgba(212,170,80,${a})`;
    g.lineWidth = w;
    g.beginPath();
    g.arc(mid, mid, size * r, 0, Math.PI * 2);
    g.stroke();
  }
  return c;
}
