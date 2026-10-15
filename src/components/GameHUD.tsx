import React, { useState } from 'react';
import { Users, Bot, User, ChevronRight, ChevronLeft, Dices } from 'lucide-react';
import { Player, GameState, MAX_ROLLS, SuddenDeathQueueItem } from '../types/game';

interface GameHUDProps {
  gameState: GameState;
  players: Player[];
  activePlayer: Player | null;
  currentSuddenDeath: SuddenDeathQueueItem | null;
  isRolling: boolean;
  onRoll: () => void;
}

export const GameHUD: React.FC<GameHUDProps> = ({
  gameState,
  players,
  activePlayer,
  currentSuddenDeath,
  isRolling,
  onRoll,
}) => {
  const [isPlayerListOpen, setIsPlayerListOpen] = useState(true);

  if (gameState === 'SETUP' || gameState === 'RESULT' || !activePlayer) {
    return null;
  }

  const isSuddenDeath = gameState === 'SUDDEN_DEATH';

  return (
    <div className="absolute inset-0 z-10 pointer-events-none flex flex-col justify-between p-4 md:p-6">
      {/* Top HUD Row */}
      <div className="flex items-start justify-between w-full pointer-events-auto">
        {/* Left: Round & Current Turn Information */}
        <div className="bg-stone-950/85 backdrop-blur-md border border-stone-800 rounded-xl p-4 shadow-lg max-w-xs md:max-w-sm">
          <div className="text-xs font-mono text-stone-400">
            {isSuddenDeath ? (
              <span>
                サドンデス：
                {currentSuddenDeath?.type === 'TOP'
                  ? '首位決定戦'
                  : currentSuddenDeath?.type === 'BOTTOM'
                  ? '最下位決定戦'
                  : '順位決定戦'}
              </span>
            ) : (
              <span>
                ラウンド投擲：{activePlayer.rollCount + 1} / {MAX_ROLLS} 回目
              </span>
            )}
          </div>

          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-xl font-bold text-stone-100">
              {activePlayer.name}
            </span>
            {activePlayer.isCpu ? (
              <span className="flex items-center gap-1 text-[11px] font-medium text-stone-300 bg-stone-800 px-2 py-0.5 rounded border border-stone-700">
                <Bot className="w-3 h-3 text-stone-400" /> CPU
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] font-medium text-stone-300 bg-stone-800 px-2 py-0.5 rounded border border-stone-700">
                <User className="w-3 h-3 text-stone-400" /> プレイヤー
              </span>
            )}
          </div>

          <div className="text-xs text-stone-400 mt-1">
            {isSuddenDeath
              ? '同点者による1投勝負です'
              : activePlayer.rollCount > 0
              ? `役なし（これまでの投擲数: ${activePlayer.rollCount}回）`
              : 'サイコロを振ってください'}
          </div>
        </div>

        {/* Right: Participant List Panel */}
        <div className="flex flex-col items-end">
          <button
            onClick={() => setIsPlayerListOpen(!isPlayerListOpen)}
            className="flex items-center gap-1.5 text-xs text-stone-300 bg-stone-950/85 border border-stone-800 px-3 py-1.5 rounded-lg shadow mb-2 hover:bg-stone-900 transition-colors"
          >
            <Users className="w-3.5 h-3.5 text-stone-400" />
            <span>参加者一覧 ({players.length}名)</span>
            {isPlayerListOpen ? (
              <ChevronRight className="w-3 h-3 text-stone-500" />
            ) : (
              <ChevronLeft className="w-3 h-3 text-stone-500" />
            )}
          </button>

          {isPlayerListOpen && (
            <div className="bg-stone-950/90 backdrop-blur-md border border-stone-800 rounded-xl p-3 shadow-xl w-56 md:w-64 max-h-[45vh] overflow-y-auto">
              <div className="space-y-1.5 text-xs">
                {players.map((p) => {
                  const isCurrent = p.id === activePlayer.id;

                  let statusText = '';
                  let statusColor = 'text-stone-400';

                  if (isSuddenDeath) {
                    const sdContender = currentSuddenDeath?.players.find(
                      (sd) => sd.playerRef.id === p.id
                    );
                    if (sdContender) {
                      if (sdContender.sdDone) {
                        statusText = `[${sdContender.sdYakuName}] 完了`;
                        statusColor = 'text-stone-300 font-semibold';
                      } else {
                        statusText = '投擲待ち';
                        statusColor = 'text-amber-400 font-semibold';
                      }
                    } else {
                      statusText = '待機';
                      statusColor = 'text-stone-500';
                    }
                  } else {
                    if (p.isDone) {
                      statusText = `[${p.yakuName}] 確定`;
                      statusColor = 'text-stone-200 font-semibold';
                    } else if (isCurrent) {
                      statusText = '手番中';
                      statusColor = 'text-amber-400 font-semibold';
                    } else {
                      statusText = `${p.rollCount}/${MAX_ROLLS}回 待機`;
                      statusColor = 'text-stone-400';
                    }
                  }

                  return (
                    <div
                      key={p.id}
                      className={`flex items-center justify-between p-2 rounded-lg transition-colors ${
                        isCurrent
                          ? 'bg-stone-800/80 border border-stone-600'
                          : 'bg-stone-900/50 border border-stone-800/60'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 truncate max-w-[120px]">
                        <span
                          className={`truncate ${
                            isCurrent ? 'text-white font-semibold' : 'text-stone-300'
                          }`}
                        >
                          {p.name}
                        </span>
                        {p.isCpu && (
                          <span className="text-[9px] text-stone-400 bg-stone-800 px-1 py-0.2 rounded shrink-0">
                            CPU
                          </span>
                        )}
                      </div>
                      <span className={`text-[11px] font-mono shrink-0 ${statusColor}`}>
                        {statusText}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Control Bar */}
      <div className="w-full flex flex-col items-center justify-end pb-4 pointer-events-auto">
        {/* Helper Tip */}
        <div className="text-[11px] text-stone-400 mb-3 bg-stone-950/70 px-3 py-1 rounded-full border border-stone-800 backdrop-blur-sm">
          画面ドラッグで3Dカメラの角度を調整できます
        </div>

        {/* Action Button Area */}
        <div className="flex flex-col items-center gap-2">
          {!activePlayer.isCpu ? (
            <button
              onClick={onRoll}
              disabled={isRolling}
              className="relative flex items-center justify-center gap-2.5 px-12 py-3.5 rounded-xl font-bold text-lg text-white transition-colors active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-500 border border-blue-400 shadow-md"
            >
              <Dices className="w-5 h-5 text-white" />
              <span>{isRolling ? 'ロール中...' : 'サイコロを振る'}</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 px-8 py-3 rounded-xl bg-stone-900 border border-stone-700 text-stone-300 text-sm shadow-md">
              <Bot className="w-4 h-4 text-stone-400" />
              <span>{isRolling ? 'CPU ロール中...' : `${activePlayer.name} 思考中...`}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
