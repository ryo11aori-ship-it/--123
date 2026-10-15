import React from 'react';
import { RotateCcw, Settings, ArrowRight } from 'lucide-react';
import { Player } from '../types/game';

interface ResultModalProps {
  isOpen: boolean;
  rankedPlayers: Player[];
  onRestart: () => void;
  onOpenSetup: () => void;
}

export const ResultModal: React.FC<ResultModalProps> = ({
  isOpen,
  rankedPlayers,
  onRestart,
  onOpenSetup,
}) => {
  if (!isOpen || rankedPlayers.length === 0) return null;

  const winner = rankedPlayers[0];
  const loser = rankedPlayers[rankedPlayers.length - 1];
  const isDraw = winner.id === loser.id;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-lg bg-stone-950 border border-stone-800 rounded-2xl shadow-2xl p-6 md:p-8 text-stone-200 text-center">
        {/* Title */}
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-stone-100">
            結果発表
          </h2>
          <p className="text-xs text-stone-400 mt-1">
            全プレイヤーの投擲が完了しました
          </p>
        </div>

        {/* Payout Banner */}
        {!isDraw && (
          <div className="mb-6 p-4 rounded-xl bg-stone-900 border border-stone-800 flex items-center justify-between text-left">
            <div className="flex items-center gap-3">
              <div>
                <div className="text-xs font-semibold text-stone-400">
                  【精算】
                </div>
                <div className="text-sm text-stone-200 mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-stone-100">{loser.name}（最下位）</span>
                  <ArrowRight className="w-3.5 h-3.5 text-stone-400 inline" />
                  <span className="font-semibold text-amber-300">{winner.name}（1位）</span>
                  <span className="text-xs text-stone-400">へ支払い</span>
                </div>
              </div>
            </div>
            <span className="text-xs font-mono text-stone-400 shrink-0">精算完了</span>
          </div>
        )}

        {/* Rankings List */}
        <div className="space-y-2 mb-6 max-h-[42vh] overflow-y-auto pr-1 text-left">
          {rankedPlayers.map((player, idx) => {
            const isTop = idx === 0;
            const isBottom = idx === rankedPlayers.length - 1 && !isTop;

            return (
              <div
                key={player.id}
                className={`flex items-center justify-between p-3 rounded-xl border transition-colors ${
                  isTop
                    ? 'bg-amber-950/30 border-amber-800/60'
                    : isBottom
                    ? 'bg-stone-900/80 border-stone-800'
                    : 'bg-stone-900/40 border-stone-800/60'
                }`}
              >
                {/* Rank & Name */}
                <div className="flex items-center gap-3">
                  <div className="w-12 text-xs font-mono font-semibold text-stone-400">
                    {isTop ? '1位' : isBottom ? '最下位' : `${idx + 1}位`}
                  </div>

                  <div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-sm font-semibold ${
                          isTop ? 'text-amber-200' : 'text-stone-200'
                        }`}
                      >
                        {player.name}
                      </span>
                      {player.isCpu && (
                        <span className="text-[10px] text-stone-400 bg-stone-800 px-1 py-0.2 rounded">
                          CPU
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-mono text-stone-400 mt-0.5">
                      出目: {player.diceResult || '-'}
                    </div>
                  </div>
                </div>

                {/* Score & Yaku */}
                <div className="text-right">
                  <div
                    className={`text-sm font-medium ${
                      isTop ? 'text-amber-300' : 'text-stone-300'
                    }`}
                  >
                    {player.yakuName || '-'}
                  </div>
                  <div className="text-xs font-mono text-stone-400">
                    {player.score !== null ? `${player.score} 点` : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <button
            onClick={onRestart}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 px-5 rounded-xl font-medium text-sm text-white bg-blue-600 hover:bg-blue-500 transition-colors shadow-sm"
          >
            <RotateCcw className="w-4 h-4" />
            <span>もう一度プレイ</span>
          </button>

          <button
            onClick={onOpenSetup}
            className="flex items-center justify-center gap-2 py-2.5 px-5 rounded-xl text-sm font-medium text-stone-300 bg-stone-900 hover:bg-stone-800 border border-stone-700 transition-colors"
          >
            <Settings className="w-4 h-4 text-stone-400" />
            <span>プレイヤー設定</span>
          </button>
        </div>
      </div>
    </div>
  );
};
