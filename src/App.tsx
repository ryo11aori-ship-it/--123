/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Player, GameState, SuddenDeathQueueItem, SuddenDeathContender, EvaluatedHand, SCORE_TABLE, MAX_ROLLS } from './types/game';
import { evaluateYaku, getShonbenYaku } from './game/evaluator';
import { ThreeSceneManager, SceneSettings, DEFAULT_SETTINGS } from './game/threeScene';
import type { RollMeta } from './physics/recording';
import { sound } from './audio/soundManager';
import { TopBar } from './components/TopBar';
import { RulesModal } from './components/RulesModal';
import { SetupModal } from './components/SetupModal';
import { ResultModal } from './components/ResultModal';
import { GameHUD } from './components/GameHUD';
import { YakuBanner } from './components/YakuBanner';
import { PhysicsPanel } from './components/PhysicsPanel';

export default function App() {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const sceneManagerRef = useRef<ThreeSceneManager | null>(null);

  // 物理ログ / 描画・物理の設定 (設定は localStorage に保存)
  const [physicsMeta, setPhysicsMeta] = useState<RollMeta | null>(null);
  const [sceneSettings, setSceneSettings] = useState<SceneSettings>(() => {
    try {
      const raw = localStorage.getItem('chinchiro.settings.v1');
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      /* 保存値が壊れていても既定値で起動 */
    }
    return DEFAULT_SETTINGS;
  });
  const settingsRef = useRef(sceneSettings);
  settingsRef.current = sceneSettings;

  // Sound state
  const [isMuted, setIsMuted] = useState(false);

  // Modals state
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  const [isSetupOpen, setIsSetupOpen] = useState(true);

  // Game state
  const [gameState, setGameState] = useState<GameState>('SETUP');
  const [players, setPlayers] = useState<Player[]>([]);
  const [currentPlayerIndex, setCurrentPlayerIndex] = useState(0);
  const [isRolling, setIsRolling] = useState(false);

  // Hand Callout Banner
  const [currentHand, setCurrentHand] = useState<EvaluatedHand | null>(null);
  const [lastDiceValues, setLastDiceValues] = useState<number[] | null>(null);
  const [lastIsShonben, setLastIsShonben] = useState(false);
  const [showYakuBanner, setShowYakuBanner] = useState(false);

  // Sudden Death State
  const suddenDeathQueueRef = useRef<SuddenDeathQueueItem[]>([]);
  const [currentSuddenDeath, setCurrentSuddenDeath] = useState<SuddenDeathQueueItem | null>(null);

  // Ranked Players for Result Modal
  const [rankedPlayers, setRankedPlayers] = useState<Player[]>([]);

  // 1. Initialize 3D Scene
  useEffect(() => {
    if (!canvasContainerRef.current) return;
    const manager = new ThreeSceneManager(canvasContainerRef.current, settingsRef.current);
    manager.onStats = setPhysicsMeta;
    sceneManagerRef.current = manager;

    return () => {
      manager.destroy();
      sceneManagerRef.current = null;
    };
  }, []);

  // 設定の変更 → シーンへ反映して保存
  const handleSettingsChange = useCallback((patch: Partial<SceneSettings>) => {
    setSceneSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem('chinchiro.settings.v1', JSON.stringify(next));
      } catch {
        /* 保存できなくても動作には影響しない */
      }
      return next;
    });
    sceneManagerRef.current?.setSettings(patch);
  }, []);

  // Audio mute toggle
  const handleToggleMute = useCallback(() => {
    const nextMuted = sound.toggleMute();
    setIsMuted(nextMuted);
  }, []);

  const handleResetCamera = useCallback(() => {
    sound.playClick();
    sceneManagerRef.current?.resetCamera();
  }, []);

  // 2. Start Game
  const handleStartGame = useCallback((newPlayers: Player[]) => {
    sound.playClick();
    sceneManagerRef.current?.resetCamera();
    setPlayers(newPlayers);
    setIsSetupOpen(false);

    // 開始者をランダムに選定
    const startIndex = Math.floor(Math.random() * newPlayers.length);
    setCurrentPlayerIndex(startIndex);

    suddenDeathQueueRef.current = [];
    setCurrentSuddenDeath(null);
    setRankedPlayers([]);
    setCurrentHand(null);
    setShowYakuBanner(false);
    setGameState('PLAYING');
  }, []);

  // 3. Process Turns (Main or Sudden Death)
  const processTurn = useCallback(() => {
    setPlayers((currentPlayers) => {
      if (gameState === 'RESULT' || currentPlayers.length === 0) return currentPlayers;

      setShowYakuBanner(false);

      if (gameState === 'PLAYING') {
        // 全員終了しているか確認
        if (currentPlayers.every((p) => p.isDone)) {
          // 本戦完了 -> 順位判定
          setTimeout(() => {
            resolveMainGameRankings(currentPlayers);
          }, 300);
          return currentPlayers;
        }

        // 次の未完了プレイヤーを探す
        let nextIdx = currentPlayerIndex;
        let loopCount = 0;
        while (currentPlayers[nextIdx].isDone && loopCount < currentPlayers.length) {
          nextIdx = (nextIdx + 1) % currentPlayers.length;
          loopCount++;
        }

        if (nextIdx !== currentPlayerIndex) {
          setCurrentPlayerIndex(nextIdx);
        }
      }

      return currentPlayers;
    });
  }, [gameState, currentPlayerIndex]);

  // CPU自動投擲トリガー
  useEffect(() => {
    if (isRolling || showYakuBanner || isSetupOpen || isRulesOpen) return;

    if (gameState === 'PLAYING') {
      const active = players[currentPlayerIndex];
      if (active && active.isCpu && !active.isDone) {
        const timer = setTimeout(() => {
          handleExecuteRoll();
        }, 1100 + Math.random() * 600);
        return () => clearTimeout(timer);
      }
    } else if (gameState === 'SUDDEN_DEATH' && currentSuddenDeath) {
      const activeContender = currentSuddenDeath.players.find((p) => !p.sdDone);
      if (activeContender && activeContender.playerRef.isCpu) {
        const timer = setTimeout(() => {
          handleExecuteRoll();
        }, 1100 + Math.random() * 600);
        return () => clearTimeout(timer);
      }
    }
  }, [gameState, currentPlayerIndex, players, currentSuddenDeath, isRolling, showYakuBanner, isSetupOpen, isRulesOpen]);

  // 4. Execute Roll
  const handleExecuteRoll = async () => {
    if (isRolling || !sceneManagerRef.current) return;

    sound.playClick();
    setIsRolling(true);
    setShowYakuBanner(false);

    try {
      const result = await sceneManagerRef.current.roll();
      setIsRolling(false);
      handleRollSettled(result.values, result.isShonben);
    } catch {
      setIsRolling(false);
    }
  };

  // 5. Handle Dice Settle & Hand Evaluation
  const handleRollSettled = (diceValues: number[], isShonben: boolean) => {
    const hand = isShonben ? getShonbenYaku() : evaluateYaku(diceValues);
    const diceStr = isShonben ? '盤外落下' : `[ ${diceValues.join(', ')} ]`;

    // 役サウンド演出
    if (isShonben || hand.score === SCORE_TABLE.HIFUMI) {
      sound.playLose();
    } else if (hand.score === SCORE_TABLE.PINZORO) {
      sound.playWin('god');
    } else if (hand.score >= SCORE_TABLE.SHIGORO) {
      sound.playWin('high');
    } else {
      sound.playBowlThud();
    }

    setCurrentHand(hand);
    setLastDiceValues(diceValues);
    setLastIsShonben(isShonben);
    setShowYakuBanner(true);

    setTimeout(() => {
      setShowYakuBanner(false);

      if (gameState === 'PLAYING') {
        setPlayers((prev) => {
          const next = [...prev];
          const active = { ...next[currentPlayerIndex] };

          active.rollCount++;
          active.diceResult = diceStr;
          active.diceValues = diceValues;

          // 役あり、または10投達した場合は確定
          if (hand.score !== SCORE_TABLE.MENASHI || active.rollCount >= MAX_ROLLS) {
            active.isDone = true;
            active.yakuName = hand.name;
            active.score = hand.score;
            active.suddenDeathSubScore = hand.sub;
          }

          next[currentPlayerIndex] = active;

          // 全員終了したかチェック
          if (next.every((p) => p.isDone)) {
            setTimeout(() => {
              resolveMainGameRankings(next);
            }, 400);
          } else {
            // 次の未完了プレイヤーを探してインデックスを更新
            let nextIndex = (currentPlayerIndex + 1) % next.length;
            while (next[nextIndex].isDone) {
              nextIndex = (nextIndex + 1) % next.length;
            }
            setCurrentPlayerIndex(nextIndex);
          }

          return next;
        });
      } else if (gameState === 'SUDDEN_DEATH') {
        if (!currentSuddenDeath) return;

        const updatedQueueItem = { ...currentSuddenDeath };
        const activeSd = updatedQueueItem.players.find((p) => !p.sdDone);
        if (activeSd) {
          activeSd.sdDone = true;
          activeSd.sdScore = hand.score;
          activeSd.sdSubScore = hand.sub;
          activeSd.sdYakuName = hand.name;
          activeSd.sdDiceResult = diceStr;
          activeSd.sdDiceValues = diceValues;
        }

        setCurrentSuddenDeath(updatedQueueItem);

        // サドンデスの全参加者が投げ終えたか確認
        if (updatedQueueItem.players.every((p) => p.sdDone)) {
          setTimeout(() => {
            resolveSuddenDeath(updatedQueueItem);
          }, 600);
        }
      }
    }, 2400);
  };

  // 6. 本戦ランキング判定とサドンデス分岐
  const resolveMainGameRankings = (finishedPlayers: Player[]) => {
    const sorted = [...finishedPlayers].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const topScore = sorted[0].score;
    const bottomScore = sorted[sorted.length - 1].score;

    const topPlayers = sorted.filter((p) => p.score === topScore);
    const bottomPlayers = sorted.filter((p) => p.score === bottomScore);

    const newQueue: SuddenDeathQueueItem[] = [];

    // 全員が同じ点数の場合 -> 1つの全体順位サドンデスで決着（重複プレイ防止）
    if (topScore === bottomScore && sorted.length > 1) {
      newQueue.push({
        type: 'ALL',
        title: '順位決定サドンデス',
        players: sorted.map((p) => ({
          playerRef: p,
          sdDone: false,
          sdScore: null,
          sdSubScore: null,
          sdYakuName: null,
          sdDiceResult: null,
        })),
      });
    } else {
      // 最下位が複数人いる場合
      if (bottomPlayers.length > 1) {
        newQueue.push({
          type: 'BOTTOM',
          title: '最下位決定サドンデス',
          players: bottomPlayers.map((p) => ({
            playerRef: p,
            sdDone: false,
            sdScore: null,
            sdSubScore: null,
            sdYakuName: null,
            sdDiceResult: null,
          })),
        });
      }

      // 首位が複数人いる場合
      if (topPlayers.length > 1) {
        newQueue.push({
          type: 'TOP',
          title: '首位決定サドンデス',
          players: topPlayers.map((p) => ({
            playerRef: p,
            sdDone: false,
            sdScore: null,
            sdSubScore: null,
            sdYakuName: null,
            sdDiceResult: null,
          })),
        });
      }
    }

    suddenDeathQueueRef.current = newQueue;
    checkNextSuddenDeath(finishedPlayers);
  };

  // サドンデスキュー進行
  const checkNextSuddenDeath = (currentPlayersList: Player[]) => {
    if (suddenDeathQueueRef.current.length > 0) {
      const nextSd = suddenDeathQueueRef.current.shift()!;
      setCurrentSuddenDeath(nextSd);
      setGameState('SUDDEN_DEATH');
    } else {
      finalizeGame(currentPlayersList);
    }
  };

  // サドンデス決着処理
  const resolveSuddenDeath = (sdItem: SuddenDeathQueueItem) => {
    const sdPlayers = [...sdItem.players];

    // サドンデス判定: メインスコア -> サブスコア(最大目×10 + 最小目)
    sdPlayers.sort((a, b) => {
      const scoreA = a.sdScore ?? 0;
      const scoreB = b.sdScore ?? 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return (b.sdSubScore ?? 0) - (a.sdSubScore ?? 0);
    });

    const topContender = sdPlayers[0];
    const bottomContender = sdPlayers[sdPlayers.length - 1];

    if (sdItem.type === 'TOP') {
      // 首位タイ確認
      const ties = sdPlayers.filter(
        (p) => p.sdScore === topContender.sdScore && p.sdSubScore === topContender.sdSubScore
      );
      if (ties.length > 1) {
        // 再サドンデス
        setTimeout(() => {
          setCurrentSuddenDeath({
            ...sdItem,
            players: ties.map((p) => ({
              ...p,
              sdDone: false,
              sdScore: null,
              sdSubScore: null,
              sdYakuName: null,
              sdDiceResult: null,
            })),
          });
        }, 1200);
        return;
      }

      // 決着: オフセット記録 (0が首位)
      sdPlayers.forEach((p, idx) => {
        p.playerRef.sdFinalRankOffset = idx;
      });
    } else if (sdItem.type === 'BOTTOM') {
      // 最下位タイ確認
      const ties = sdPlayers.filter(
        (p) => p.sdScore === bottomContender.sdScore && p.sdSubScore === bottomContender.sdSubScore
      );
      if (ties.length > 1) {
        // 再サドンデス
        setTimeout(() => {
          setCurrentSuddenDeath({
            ...sdItem,
            players: ties.map((p) => ({
              ...p,
              sdDone: false,
              sdScore: null,
              sdSubScore: null,
              sdYakuName: null,
              sdDiceResult: null,
            })),
          });
        }, 1200);
        return;
      }

      // 決着: オフセット記録 (大きいほど最下位)
      sdPlayers.forEach((p, idx) => {
        p.playerRef.sdFinalRankOffset = idx;
      });
    } else {
      // ALL: 全体タイ
      sdPlayers.forEach((p, idx) => {
        p.playerRef.sdFinalRankOffset = idx;
      });
    }

    setPlayers((prev) => {
      const updated = [...prev];
      setTimeout(() => {
        checkNextSuddenDeath(updated);
      }, 1200);
      return updated;
    });
  };

  // 7. Finalize Game
  const finalizeGame = (basePlayers: Player[]) => {
    const finalSorted = [...basePlayers].sort((a, b) => {
      const scoreA = a.score ?? 0;
      const scoreB = b.score ?? 0;
      if (scoreB !== scoreA) return scoreB - scoreA;

      // サドンデスオフセットがあれば比較
      if (a.sdFinalRankOffset !== undefined && b.sdFinalRankOffset !== undefined) {
        return a.sdFinalRankOffset - b.sdFinalRankOffset;
      }

      // サブスコアで比較
      return (b.suddenDeathSubScore ?? 0) - (a.suddenDeathSubScore ?? 0);
    });

    setRankedPlayers(finalSorted);
    setGameState('RESULT');
  };

  // 8. 再戦 (同じ参加者で即座に新規ゲーム開始)
  const handleRestart = () => {
    const freshPlayers = players.map((p, idx) => ({
      ...p,
      rollCount: 0,
      isDone: false,
      yakuName: null,
      score: null,
      diceResult: null,
      suddenDeathSubScore: 0,
      sdFinalRankOffset: undefined,
    }));
    handleStartGame(freshPlayers);
  };

  // 現在のアクティブプレイヤー
  const activePlayer =
    gameState === 'PLAYING'
      ? players[currentPlayerIndex] || null
      : gameState === 'SUDDEN_DEATH' && currentSuddenDeath
      ? currentSuddenDeath.players.find((p) => !p.sdDone)?.playerRef || null
      : null;

  // キーボード: Space / Enter で投擲 (人間の手番のとき)
  const rollRef = useRef(handleExecuteRoll);
  rollRef.current = handleExecuteRoll;
  const canRollNow =
    !isRolling &&
    !showYakuBanner &&
    !isSetupOpen &&
    !isRulesOpen &&
    !!activePlayer &&
    !activePlayer.isCpu &&
    (gameState === 'PLAYING' || gameState === 'SUDDEN_DEATH');
  useEffect(() => {
    if (!canRollNow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.code !== 'Enter') return;
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT' || (e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
      e.preventDefault();
      rollRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canRollNow]);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0e0e11] font-sans text-stone-200">
      {/* 3D WebGL Canvas Layer */}
      <div ref={canvasContainerRef} className="absolute inset-0 z-0 w-full h-full cursor-grab active:cursor-grabbing" />
      <div className="vignette pointer-events-none absolute inset-0 z-[5]" aria-hidden="true" />

      {/* Top Bar Header */}
      <TopBar
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        onResetCamera={handleResetCamera}
        onOpenRules={() => setIsRulesOpen(true)}
        onOpenSetup={() => setIsSetupOpen(true)}
        gameState={gameState}
      />

      {/* In-Game HUD (Status, Participants, Controls) */}
      <GameHUD
        gameState={gameState}
        players={players}
        activePlayer={activePlayer}
        currentSuddenDeath={currentSuddenDeath}
        isRolling={isRolling}
        onRoll={handleExecuteRoll}
      />

      {/* Dramatic Yaku Callout Banner */}
      <YakuBanner
        hand={currentHand}
        diceValues={lastDiceValues}
        isShonben={lastIsShonben}
        isVisible={showYakuBanner}
      />

      {/* 物理ログ・設定 */}
      <PhysicsPanel meta={physicsMeta} settings={sceneSettings} onChange={handleSettingsChange} />

      {/* Rules Modal */}
      <RulesModal isOpen={isRulesOpen} onClose={() => setIsRulesOpen(false)} />

      {/* Participant Setup Modal */}
      <SetupModal
        isOpen={isSetupOpen}
        onStartGame={handleStartGame}
        initialPlayers={players.length > 0 ? players : undefined}
        onClose={() => setIsSetupOpen(false)}
        canClose={gameState !== 'SETUP'}
      />

      {/* Final Result Modal */}
      <ResultModal
        isOpen={gameState === 'RESULT'}
        rankedPlayers={rankedPlayers}
        onRestart={handleRestart}
        onOpenSetup={() => setIsSetupOpen(true)}
      />
    </div>
  );
}
