import React from 'react';
import { X, BookOpen, Info } from 'lucide-react';

interface RulesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RulesModal: React.FC<RulesModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const yakuList = [
    {
      name: 'ピンゾロ',
      dice: [1, 1, 1, 1, 1],
      score: '1,000 点',
      desc: '5個のサイコロすべてが「1」。最上位の役。',
      color: 'text-amber-400 font-bold',
    },
    {
      name: 'アラシ',
      dice: [5, 5, 5, 5, 5],
      score: '900 + n 点',
      desc: '5個のサイコロすべてが同数（2〜6）。出目が大きいほど上位（例: 6のアラシ＝906点）。',
      color: 'text-amber-300 font-semibold',
    },
    {
      name: '目あり',
      dice: [3, 3, 3, 3, 6],
      score: '800 + n 点',
      desc: '4個が同数で、残り1個が別の数字。その1個の数字が得点（例: 6の目＝806点）。',
      color: 'text-emerald-400 font-semibold',
    },
    {
      name: 'シゴロ',
      dice: [4, 5, 6, 2, 2],
      score: '300 点',
      desc: '4・5・6が各1個以上あり、残りの2個が同数（ペア）。',
      color: 'text-sky-400 font-semibold',
    },
    {
      name: '役なし',
      dice: [2, 3, 4, 1, 5],
      score: '0 点',
      desc: 'いずれの役にも該当しない。サドンデス時は（最大出目×10 + 最小出目）で優劣を比較。',
      color: 'text-stone-300',
    },
    {
      name: 'ションベン',
      dice: [0, 0, 0, 0, 0],
      score: '-50 点',
      desc: 'サイコロがお椀の外に落下した場合（発生確率は1%固定）。',
      color: 'text-rose-400 font-medium',
    },
    {
      name: 'ヒフミ',
      dice: [1, 2, 3, 5, 5],
      score: '-100 点',
      desc: '1・2・3が各1個以上あり、残りの2個が同数（ペア）。最下位の役。',
      color: 'text-purple-400 font-semibold',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-stone-950 border border-stone-800 rounded-2xl shadow-2xl p-6 md:p-8 max-h-[90vh] flex flex-col text-stone-200">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-stone-800">
          <div className="flex items-center gap-2.5">
            <BookOpen className="w-5 h-5 text-stone-400" />
            <h2 className="text-xl md:text-2xl font-bold text-stone-100">
              ルール説明
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-stone-400 hover:text-white hover:bg-stone-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Scrollable */}
        <div className="overflow-y-auto pr-1 mt-4 space-y-6 text-sm">
          {/* 役一覧 */}
          <div>
            <h3 className="text-xs font-semibold text-stone-400 uppercase tracking-wider mb-3">
              役の強さと得点一覧
            </h3>

            <div className="space-y-2">
              {yakuList.map((yaku, idx) => (
                <div
                  key={idx}
                  className="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-xl bg-stone-900 border border-stone-800 gap-2"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-stone-500 w-5">0{idx + 1}</span>
                    <span className={`text-sm ${yaku.color}`}>{yaku.name}</span>
                    {yaku.dice[0] !== 0 ? (
                      <div className="flex items-center gap-1">
                        {yaku.dice.map((d, dIdx) => (
                          <span
                            key={dIdx}
                            className={`w-5 h-5 flex items-center justify-center text-xs font-bold rounded ${
                              d === 1 || d === 4
                                ? 'bg-rose-950/80 text-rose-300 border border-rose-800/60'
                                : 'bg-stone-800 text-stone-200 border border-stone-700'
                            }`}
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-rose-400 italic">落下</span>
                    )}
                  </div>

                  <div className="flex sm:flex-col items-baseline sm:items-end justify-between sm:justify-center">
                    <span className="font-mono font-bold text-amber-300 text-sm">{yaku.score}</span>
                    <span className="text-xs text-stone-400 sm:max-w-[280px] sm:text-right">
                      {yaku.desc}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 進行と精算ルール */}
          <div className="p-4 rounded-xl bg-stone-900 border border-stone-800 space-y-2">
            <h4 className="flex items-center gap-1.5 text-xs font-bold text-stone-300">
              <Info className="w-4 h-4 text-stone-400" /> 進行・サドンデス・精算
            </h4>
            <ul className="text-xs text-stone-300 space-y-1.5 leading-relaxed list-disc list-inside">
              <li>
                <strong className="text-stone-100">投擲回数:</strong> 1人最大10投。役が出た時点で確定。役なしの場合は次のプレイヤーへ交代し、全員が確定するまで順に投擲します。
              </li>
              <li>
                <strong className="text-stone-100">サドンデス:</strong> 首位または最下位が同点で並んだ場合、該当者のみで1投勝負を実施します。役なし同士の場合は「最大出目×10 + 最小出目」が高い方が上位となります。
              </li>
              <li>
                <strong className="text-stone-100">ションベン:</strong> サイコロがお椀の外に落下する役です。発生確率は1回あたり固定で1%（0.01）に設定されています。
              </li>
              <li>
                <strong className="text-stone-100">精算:</strong> 全体の最終結果に基づき、最下位のプレイヤーが首位のプレイヤーへ支払いを行います。
              </li>
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-4 mt-4 border-t border-stone-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-stone-800 hover:bg-stone-700 text-white font-medium text-sm rounded-lg transition-colors"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};
