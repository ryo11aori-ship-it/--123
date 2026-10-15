import React from 'react';
import { EvaluatedHand } from '../types/game';

interface YakuBannerProps {
  hand: EvaluatedHand | null;
  diceValues: number[] | null;
  isShonben: boolean;
  isVisible: boolean;
}

export const YakuBanner: React.FC<YakuBannerProps> = ({
  hand,
  diceValues,
  isShonben,
  isVisible,
}) => {
  if (!isVisible || !hand) return null;

  const isWin = hand.type === 'win';
  const isLose = hand.type === 'lose';

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center pointer-events-none p-4">
      <div className="relative flex flex-col items-center p-6 rounded-2xl bg-stone-950/90 backdrop-blur-md border border-stone-700 shadow-2xl animate-in zoom-in-95 duration-200 max-w-sm sm:max-w-md w-full">
        {/* Hand Title */}
        <h2
          className={`text-4xl sm:text-5xl font-bold tracking-wide text-center ${
            isWin
              ? 'text-amber-300'
              : isShonben
              ? 'text-rose-400'
              : isLose
              ? 'text-purple-300'
              : 'text-stone-100'
          }`}
        >
          {hand.name}
        </h2>

        {/* Dice Visual Row */}
        {!isShonben && diceValues && diceValues.length > 0 && (
          <div className="mt-4 flex items-center justify-center gap-2">
            {diceValues.map((val, idx) => {
              const isRed = val === 1 || val === 4;
              return (
                <div
                  key={idx}
                  className={`w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center rounded-lg font-bold text-base sm:text-lg font-mono border ${
                    isRed
                      ? 'bg-rose-950/80 text-rose-300 border-rose-700'
                      : 'bg-stone-900 text-stone-100 border-stone-700'
                  }`}
                >
                  {val}
                </div>
              );
            })}
          </div>
        )}

        {/* Subtitle Description */}
        <p className="mt-3 text-sm text-stone-300 text-center">
          {hand.description}
        </p>

        {/* Score Information */}
        <div className="mt-2 text-xs font-mono text-stone-400">
          得点: {hand.score} 点
        </div>
      </div>
    </div>
  );
};
