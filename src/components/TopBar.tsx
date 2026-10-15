import React from 'react';
import { Volume2, VolumeX, RotateCcw, BookOpen, Settings } from 'lucide-react';

interface TopBarProps {
  isMuted: boolean;
  onToggleMute: () => void;
  onResetCamera: () => void;
  onOpenRules: () => void;
  onOpenSetup: () => void;
  gameState: string;
}

export const TopBar: React.FC<TopBarProps> = ({
  isMuted,
  onToggleMute,
  onResetCamera,
  onOpenRules,
  onOpenSetup,
}) => {
  return (
    <header className="relative z-30 flex items-center justify-between gap-8 px-5 py-3 bg-stone-950/80 backdrop-blur-md border-b border-stone-800 text-stone-200 select-none">
      {/* Zone 1: Single text element wordmark */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="font-sans font-bold text-lg md:text-xl text-stone-100">
          チンチロリン
        </span>
        <span className="text-xs font-mono text-stone-400 border border-stone-700 px-1.5 py-0.5 rounded">
          5ダイス
        </span>
      </div>

      {/* Zone 2: Navigation Links */}
      <nav className="flex items-center gap-4 sm:gap-6 text-xs md:text-sm">
        <button
          onClick={onOpenRules}
          className="flex items-center gap-1.5 text-stone-300 hover:text-white transition-colors whitespace-nowrap shrink-0 py-1"
        >
          <BookOpen className="w-4 h-4 text-stone-400" />
          <span>役一覧・ルール</span>
        </button>

        <button
          onClick={onResetCamera}
          className="flex items-center gap-1.5 text-stone-300 hover:text-white transition-colors whitespace-nowrap shrink-0 py-1"
          title="3D視点を初期位置に戻します"
        >
          <RotateCcw className="w-4 h-4 text-stone-400" />
          <span className="hidden sm:inline">視点リセット</span>
        </button>

        <button
          onClick={onToggleMute}
          className="flex items-center gap-1.5 text-stone-300 hover:text-white transition-colors whitespace-nowrap shrink-0 py-1"
        >
          {isMuted ? (
            <>
              <VolumeX className="w-4 h-4 text-stone-500" />
              <span className="hidden sm:inline">音声 OFF</span>
            </>
          ) : (
            <>
              <Volume2 className="w-4 h-4 text-stone-300" />
              <span className="hidden sm:inline">音声 ON</span>
            </>
          )}
        </button>
      </nav>

      {/* Zone 3: 1 primary action */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={onOpenSetup}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-200 bg-stone-900 hover:bg-stone-800 border border-stone-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <Settings className="w-3.5 h-3.5 text-stone-400" />
          <span>プレイヤー設定</span>
        </button>
      </div>
    </header>
  );
};
