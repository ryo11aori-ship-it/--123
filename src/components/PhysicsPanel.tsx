import React, { useState } from 'react';
import { Settings, X } from 'lucide-react';
import type { RollMeta } from '../physics/recording';
import type { SceneSettings } from '../game/threeScene';

interface Props {
  meta: RollMeta | null;
  settings: SceneSettings;
  onChange: (patch: Partial<SceneSettings>) => void;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-stone-500">{label}</span>
      <span className="font-mono text-stone-200 tabular-nums">{value}</span>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between text-[11px] mb-1">
        <span className="text-stone-400">{label}</span>
        <span className="font-mono text-amber-300/90 tabular-nums">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-amber-500 h-1.5"
      />
    </label>
  );
}

/** 右端の歯車ボタン → 物理ログ (直近の投擲の内訳) と見た目/物理の設定 */
export function PhysicsPanel({ meta, settings, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rejected = meta ? meta.rejected : null;
  const reroll = rejected ? rejected.cocked + rejected.stacked : 0;

  return (
    <div className="absolute right-3 top-1/2 -translate-y-1/2 z-30 flex flex-col items-end gap-2 pointer-events-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? '物理ログと設定を閉じる' : '物理ログと設定を開く'}
        title="物理ログ・設定"
        className="pointer-events-auto w-10 h-10 rounded-full bg-stone-950/80 border border-stone-700/80 text-stone-300 hover:text-amber-300 hover:border-amber-600/70 backdrop-blur flex items-center justify-center transition-colors shadow-lg"
      >
        {open ? <X size={18} /> : <Settings size={18} />}
      </button>

      {open && (
        <div className="pointer-events-auto w-[min(86vw,17rem)] max-h-[70vh] overflow-y-auto rounded-xl bg-stone-950/90 border border-stone-700/80 backdrop-blur-md p-4 text-xs shadow-2xl space-y-4">
          <div>
            <div className="text-amber-300/90 font-bold tracking-wider mb-2 text-[11px]">物理シミュレーション ログ</div>
            {meta ? (
              <div className="space-y-1">
                <Row label="乱数シード" value={meta.seedLabel} />
                <Row label="計算ステップ" value={`${meta.steps.toLocaleString()} (${meta.stepHz}Hz)`} />
                <Row label="衝突" value={`${meta.impacts} 回 (椀 ${meta.bowlImpacts} / 賽 ${meta.diceImpacts})`} />
                <Row label="最大めり込み" value={`${meta.maxPenetrationMm.toFixed(2)} mm`} />
                <Row label="計算時間" value={`${meta.simMs.toFixed(0)} ms`} />
                <Row label="凹凸の強さ" value={`×${meta.bumpScale.toFixed(2)}`} />
                <Row label="振り直し(傾き/重なり)" value={`${reroll} 回`} />
              </div>
            ) : (
              <div className="text-stone-500">投擲すると、ここに物理計算の内訳が表示されます。</div>
            )}
            <p className="mt-2 text-[10px] leading-relaxed text-stone-500">
              目は物理シミュレーションの結果で決まります。お椀の細かな凹凸(ろくろ目・槌目・ピンホール)に賽の角が当たり、結果が複雑に変わります。
            </p>
          </div>

          <div className="space-y-3 border-t border-stone-800 pt-3">
            <Slider
              label="お椀の凹凸の強さ"
              value={settings.bumpScale}
              min={0}
              max={2}
              step={0.05}
              format={(v) => (v === 0 ? 'なし' : `×${v.toFixed(2)}`)}
              onChange={(v) => onChange({ bumpScale: v })}
            />
            <Slider
              label="再生速度 (小さいほどスロー)"
              value={settings.timeScale}
              min={0.3}
              max={1}
              step={0.05}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={(v) => onChange({ timeScale: v })}
            />
            <Slider
              label="画面の明るさ"
              value={settings.brightness}
              min={0.6}
              max={1.6}
              step={0.05}
              format={(v) => `${v.toFixed(2)}`}
              onChange={(v) => onChange({ brightness: v })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
