export const THEMES = ["animaux", "objets", "alimentation", "lieux", "metiers"] as const;
export const DIFFICULTIES = ["facile", "moyen", "difficile"] as const;
export const DURATIONS = [30, 60, 90] as const;
export const ROUND_COUNTS = [5, 10, 15] as const;
export const MAX_STROKES_PER_TURN = 240;
export const MAX_POINTS_PER_STROKE = 1_024;
export const MAX_POINTS_PER_TURN = 8_000;

export type Theme = (typeof THEMES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];
export type Role = "controller" | "terminal";
export type TerminalDisplayMode = "drawing" | "projection";
export type GamePhase = "lobby" | "awaiting_ready" | "armed" | "drawing" | "resolving" | "revealing" | "finished";
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
  difficulty: Difficulty;
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
  canvasRevision: number;
}

export interface Session {
  id: string;
  token: string;
  role: Role;
  displayMode?: TerminalDisplayMode;
  createdAt: number;
  lastSeenAt: number;
  commandWindowStartedAt?: number;
  commandCount?: number;
}

export interface ConnectionTicket {
  value: string;
  sessionId: string;
  expiresAt: number;
}

export interface RoomState {
  version: 3;
  code: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  revision: number;
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
  canvasRevision: number;
}

export interface DevicePresence {
  projectors: number;
  drawingPhones: number;
  hasRequiredDevices: boolean;
}

export interface RoomSnapshot {
  code: string;
  revision: number;
  phase: GamePhase;
  settings: Settings;
  players: Player[];
  turn: PublicTurn | null;
  canDraw: boolean;
  canTakeDrawingTurn: boolean;
  canSelectWinner: boolean;
  displayMode: TerminalDisplayMode;
  devicePresence: DevicePresence;
  secretWord: string | null;
  finishedWinnerIds: string[];
  serverNow: number;
}

export const DEFAULT_SETTINGS: Settings = {
  durationSeconds: 60,
  rounds: 10,
  difficulty: "moyen",
};
