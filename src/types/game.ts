export type PlayerId = number;

export interface Player {
  id: PlayerId;
  name: string;
  isCpu: boolean;
  rollCount: number;
  isDone: boolean;
  yakuName: string | null;
  score: number | null;
  diceResult: string | null;
  diceValues?: number[];
  suddenDeathSubScore: number;
  sdFinalRankOffset?: number;
}

export type HandType = 'win' | 'lose' | 'normal' | 'shonben';

export interface EvaluatedHand {
  name: string;
  score: number;
  type: HandType;
  sub: number;
  description: string;
}

export type GameState = 'SETUP' | 'PLAYING' | 'SUDDEN_DEATH' | 'RESULT';

export interface SuddenDeathContender {
  playerRef: Player;
  sdDone: boolean;
  sdScore: number | null;
  sdSubScore: number | null;
  sdYakuName: string | null;
  sdDiceResult: string | null;
  sdDiceValues?: number[];
}

export interface SuddenDeathQueueItem {
  type: 'TOP' | 'BOTTOM' | 'ALL';
  title: string;
  players: SuddenDeathContender[];
}

export const SCORE_TABLE = {
  PINZORO: 1000,
  ARASHI_BASE: 900,
  MEARI_BASE: 800,
  SHIGORO: 300,
  MENASHI: 0,
  SHONBEN: -50,
  HIFUMI: -100,
} as const;

export const DICE_COUNT = 5;
export const MAX_ROLLS = 10;
