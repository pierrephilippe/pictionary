export const THEMES = ["animaux", "objets", "alimentation", "lieux", "metiers"] as const;
export const DIFFICULTIES = ["facile", "moyen", "difficile"] as const;
export const DURATIONS = [30, 60, 90] as const;
export const ROUND_COUNTS = [5, 10, 15] as const;

export type Theme = (typeof THEMES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];
export type Role = "controller" | "terminal";
export type ProjectionLayout = "pyramid" | "vee" | "single";
export type GamePhase = "lobby" | "awaiting_ready" | "armed" | "drawing" | "revealing" | "finished";
export type Tool = "pen" | "eraser";

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  id: string;
  tool: Tool;
  width: number;
  points: Point[];
  complete: boolean;
}

export interface Player {
  id: string;
  name: string;
  score: number;
  joinedAt: number;
}

export interface Settings {
  durationSeconds: (typeof DURATIONS)[number];
  rounds: (typeof ROUND_COUNTS)[number];
  themes: Theme[];
  difficulties: Difficulty[];
}

export interface Word {
  id: string;
  label: string;
  theme: Theme;
  difficulty: Difficulty;
}

export interface CurrentTurn {
  id: string;
  round: number;
  drawerId: string;
  word: Word | null;
  strokes: Stroke[];
  redoStrokes: Stroke[];
  pointCount: number;
  readyDeadlineAt: number;
  armedDeadlineAt: number | null;
  startedAt: number | null;
  deadlineAt: number | null;
  revealedAt: number | null;
  winnerId: string | null;
  nextDrawerId: string | null;
  drawerTerminalSessionId: string | null;
}

export interface Session {
  id: string;
  token: string;
  role: Role;
  createdAt: number;
  lastSeenAt: number;
}

export interface ConnectionTicket {
  value: string;
  sessionId: string;
  expiresAt: number;
}

export interface RoomState {
  version: 1;
  code: string;
  createdAt: number;
  updatedAt: number;
  phase: GamePhase;
  settings: Settings;
  players: Player[];
  sessions: Session[];
  tickets: ConnectionTicket[];
  turnSequence: number;
  current: CurrentTurn | null;
  usedWordIds: string[];
  finishedWinnerIds: string[];
}

export interface PublicTurn {
  id: string;
  round: number;
  drawerId: string;
  drawerName: string;
  readyDeadlineAt: number;
  armedDeadlineAt: number | null;
  deadlineAt: number | null;
  revealedWord: string | null;
  strokes: Stroke[];
  winnerId: string | null;
  nextDrawerId: string | null;
}

export interface RoomSnapshot {
  code: string;
  phase: GamePhase;
  settings: Settings;
  players: Player[];
  turn: PublicTurn | null;
  canDraw: boolean;
  canTakeDrawingTurn: boolean;
  canSelectWinner: boolean;
  secretWord: string | null;
  finishedWinnerIds: string[];
  serverNow: number;
}

export const DEFAULT_SETTINGS: Settings = {
  durationSeconds: 60,
  rounds: 10,
  themes: [...THEMES],
  difficulties: [...DIFFICULTIES],
};
