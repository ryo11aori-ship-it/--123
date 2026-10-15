import React, { useState } from 'react';
import { User, Bot, Plus, Trash2, Play } from 'lucide-react';
import { Player } from '../types/game';

interface SetupModalProps {
  isOpen: boolean;
  onStartGame: (players: Player[]) => void;
  initialPlayers?: Player[];
  onClose?: () => void;
  canClose?: boolean;
}

interface RawConfigPlayer {
  id: number;
  name: string;
  isCpu: boolean;
}

export const SetupModal: React.FC<SetupModalProps> = ({
  isOpen,
  onStartGame,
  initialPlayers,
  onClose,
  canClose = false,
}) => {
  const [configPlayers, setConfigPlayers] = useState<RawConfigPlayer[]>(() => {
    if (initialPlayers && initialPlayers.length >= 2) {
      return initialPlayers.map((p) => ({ id: p.id, name: p.name, isCpu: p.isCpu }));
    }
    return [
      { id: 0, name: 'プレイヤー1', isCpu: false },
      { id: 1, name: 'CPU 1', isCpu: true },
      { id: 2, name: 'CPU 2', isCpu: true },
      { id: 3, name: 'CPU 3', isCpu: true },
    ];
  });

  if (!isOpen) return null;

  const handleAddPlayer = () => {
    if (configPlayers.length >= 8) return;
    const newId = Date.now();
    setConfigPlayers((prev) => [
      ...prev,
      { id: newId, name: `CPU ${prev.length + 1}`, isCpu: true },
    ]);
  };

  const handleRemovePlayer = (id: number) => {
    if (configPlayers.length <= 2) return;
    setConfigPlayers((prev) => prev.filter((p) => p.id !== id));
  };

  const handleToggleCpu = (id: number) => {
    setConfigPlayers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, isCpu: !p.isCpu } : p))
    );
  };

  const handleNameChange = (id: number, name: string) => {
    setConfigPlayers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name } : p))
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (configPlayers.length < 2) return;

    const initialized: Player[] = configPlayers.map((p, index) => ({
      id: index,
      name: p.name.trim() || `プレイヤー${index + 1}`,
      isCpu: p.isCpu,
      rollCount: 0,
      isDone: false,
      yakuName: null,
      score: null,
      diceResult: null,
      suddenDeathSubScore: 0,
    }));

    onStartGame(initialized);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-md bg-stone-950 border border-stone-800 rounded-2xl shadow-2xl p-6 md:p-8 text-stone-200">
        <div className="text-center mb-6">
          <h2 className="text-xl font-bold text-stone-100">
            プレイヤー設定
          </h2>
          <p className="text-xs text-stone-400 mt-1">
            参加人数（2〜8名）を設定してください
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2 max-h-[46vh] overflow-y-auto pr-1">
            {configPlayers.map((player, index) => (
              <div
                key={player.id}
                className="flex items-center gap-2 p-2.5 rounded-xl bg-stone-900 border border-stone-800"
              >
                <div className="w-6 text-center text-xs font-mono text-stone-500">
                  {index + 1}
                </div>

                <input
                  type="text"
                  value={player.name}
                  onChange={(e) => handleNameChange(player.id, e.target.value)}
                  maxLength={12}
                  className="flex-grow bg-stone-950 border border-stone-700 rounded-lg px-2.5 py-1.5 text-sm text-stone-100 focus:outline-none focus:border-stone-500"
                  placeholder="プレイヤー名"
                />

                <button
                  type="button"
                  onClick={() => handleToggleCpu(player.id)}
                  className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    player.isCpu
                      ? 'bg-stone-800 text-stone-300 hover:bg-stone-700'
                      : 'bg-blue-950 text-blue-300 border border-blue-800 hover:bg-blue-900'
                  }`}
                  title="人間とCPUの切り替え"
                >
                  {player.isCpu ? (
                    <>
                      <Bot className="w-3.5 h-3.5 text-stone-400" />
                      <span>CPU</span>
                    </>
                  ) : (
                    <>
                      <User className="w-3.5 h-3.5 text-blue-400" />
                      <span>プレイヤー</span>
                    </>
                  )}
                </button>

                {configPlayers.length > 2 && (
                  <button
                    type="button"
                    onClick={() => handleRemovePlayer(player.id)}
                    className="p-1.5 text-stone-500 hover:text-rose-400 hover:bg-stone-800 rounded-lg transition-colors"
                    title="削除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-between items-center pt-2">
            <button
              type="button"
              onClick={handleAddPlayer}
              disabled={configPlayers.length >= 8}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-stone-300 bg-stone-900 hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed border border-stone-700 rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5 text-stone-400" />
              <span>プレイヤー追加 ({configPlayers.length}/8)</span>
            </button>

            {canClose && onClose && (
              <button
                type="button"
                onClick={onClose}
                className="text-xs text-stone-400 hover:text-stone-200 px-3 py-1.5"
              >
                キャンセル
              </button>
            )}
          </div>

          <button
            type="submit"
            className="w-full mt-4 flex items-center justify-center gap-2 py-3 px-6 rounded-xl font-bold text-base text-white bg-blue-600 hover:bg-blue-500 transition-colors shadow-md"
          >
            <Play className="w-4 h-4 fill-white" />
            <span>ゲーム開始</span>
          </button>
        </form>
      </div>
    </div>
  );
};
