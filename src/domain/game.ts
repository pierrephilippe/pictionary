import { CATALOGUE } from "./catalogue";
import {
  DEFAULT_SETTINGS,
  type CurrentTurn,
  type GamePhase,
  type Player,
  type RoomSnapshot,
  type RoomState,
  type Session,
  type Settings,
  type Stroke,
  type Word,
} from "./types";

export class GameRuleError extends Error {}

export const MAX_STROKES_PER_TURN = 240;
export const MAX_POINTS_PER_STROKE = 1_024;
export const MAX_POINTS_PER_TURN = 8_000;
export const REVEAL_DURATION_MS = 5_000;
export const READY_DURATION_MS = 30_000;

export interface AppendStrokeResult {
  deadlineAt: number | null;
  stroke: Stroke;
}

export const createRoomState = (code: string, controller: Session, now: number): RoomState => ({
  version: 1,
  code,
  createdAt: now,
  updatedAt: now,
  phase: "lobby",
  settings: structuredClone(DEFAULT_SETTINGS),
  players: [],
  sessions: [controller],
  tickets: [],
  turnSequence: 0,
  current: null,
  usedWordIds: [],
  finishedWinnerIds: [],
});

export const getPlayer = (state: RoomState, playerId: string): Player => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new GameRuleError("Joueur introuvable.");
  return player;
};

const availablePlayers = (state: RoomState, excludingId?: string): Player[] =>
  state.players.filter((player) => player.id !== excludingId);

const chooseNextDrawer = (state: RoomState, currentDrawerId: string, random: () => number): Player => {
  const alternatives = availablePlayers(state, currentDrawerId);
  return chooseRandom(alternatives.length > 0 ? alternatives : state.players, random);
};

const chooseRandom = <T>(items: T[], random: () => number): T => {
  if (items.length === 0) throw new GameRuleError("Aucun joueur disponible.");
  return items[Math.floor(random() * items.length)]!;
};

const chooseWord = (state: RoomState, random: () => number): Word => {
  const matching = CATALOGUE.filter(
    (word) => state.settings.themes.includes(word.theme) && state.settings.difficulties.includes(word.difficulty),
  );
  if (matching.length === 0) throw new GameRuleError("Choisissez au moins un thème et une difficulté.");
  let candidates = matching.filter((word) => !state.usedWordIds.includes(word.id));
  if (candidates.length === 0) {
    state.usedWordIds = [];
    candidates = matching;
  }
  const word = chooseRandom(candidates, random);
  state.usedWordIds.push(word.id);
  return word;
};

const newTurn = (round: number, drawerId: string, sequence: number, now: number): CurrentTurn => ({
  id: `turn-${sequence}`,
  round,
  drawerId,
  word: null,
  strokes: [],
  redoStrokes: [],
  pointCount: 0,
  readyDeadlineAt: now + READY_DURATION_MS,
  armedDeadlineAt: null,
  startedAt: null,
  deadlineAt: null,
  revealedAt: null,
  winnerId: null,
  nextDrawerId: null,
  drawerTerminalSessionId: null,
});

const createTurn = (state: RoomState, round: number, drawerId: string, now: number): CurrentTurn => {
  state.turnSequence = (state.turnSequence ?? 0) + 1;
  return newTurn(round, drawerId, state.turnSequence, now);
};

const prepareTurnDrawingState = (turn: CurrentTurn): void => {
  turn.redoStrokes ??= [];
  if (!Number.isInteger(turn.pointCount) || turn.pointCount < 0) {
    turn.pointCount = turn.strokes.reduce((total, stroke) => total + stroke.points.length, 0);
  }
};

const normaliseStroke = (stroke: Stroke): Stroke => ({
  ...structuredClone(stroke),
  points: stroke.points.map((point) => ({
    x: Math.round(point.x * 10_000) / 10_000,
    y: Math.round(point.y * 10_000) / 10_000,
  })),
});

export function configure(state: RoomState, settings: Settings, now: number): void {
  if (state.phase !== "lobby") throw new GameRuleError("La partie a déjà commencé.");
  if (settings.themes.length === 0 || settings.difficulties.length === 0) {
    throw new GameRuleError("Choisissez au moins un thème et une difficulté.");
  }
  state.settings = structuredClone(settings);
  state.updatedAt = now;
}

export function addPlayer(state: RoomState, player: Player, now: number): void {
  if (state.phase !== "lobby") throw new GameRuleError("Les inscriptions sont fermées.");
  if (state.players.length >= 12) throw new GameRuleError("La salle est pleine.");
  if (state.players.some((candidate) => candidate.name.localeCompare(player.name, "fr", { sensitivity: "accent" }) === 0)) {
    throw new GameRuleError("Ce pseudo est déjà utilisé dans la salle.");
  }
  state.players.push(player);
  state.updatedAt = now;
}

export function startGame(state: RoomState, now: number, random: () => number): void {
  if (state.phase !== "lobby") throw new GameRuleError("La partie est déjà lancée.");
  if (state.players.length < 1) throw new GameRuleError("Ajoutez au moins un joueur avant de lancer la partie.");
  const drawer = chooseRandom(state.players, random);
  state.current = createTurn(state, 1, drawer.id, now);
  state.phase = "awaiting_ready";
  state.updatedAt = now;
}

export function takeDrawingTurn(state: RoomState, terminalSessionId: string, now: number): void {
  const current = state.current;
  if (state.phase !== "awaiting_ready" || !current) throw new GameRuleError("Ce tour ne peut plus être pris en charge.");
  if (current.drawerTerminalSessionId && current.drawerTerminalSessionId !== terminalSessionId) {
    throw new GameRuleError("Un autre téléphone est déjà utilisé pour ce tour.");
  }
  current.drawerTerminalSessionId = terminalSessionId;
  state.updatedAt = now;
}

const assertDrawerTerminal = (state: RoomState, terminalSessionId: string): CurrentTurn => {
  const current = state.current;
  if (!current || current.drawerTerminalSessionId !== terminalSessionId) {
    throw new GameRuleError("Ce téléphone n’est pas le terminal de dessin de ce tour.");
  }
  return current;
};

export function ready(state: RoomState, terminalSessionId: string, now: number, random: () => number): void {
  if (state.phase !== "awaiting_ready") {
    throw new GameRuleError("Seul le dessinateur désigné peut se déclarer prêt.");
  }
  const current = assertDrawerTerminal(state, terminalSessionId);
  current.word = chooseWord(state, random);
  current.armedDeadlineAt = now + READY_DURATION_MS;
  state.phase = "armed";
  state.updatedAt = now;
}

export function expireReadyDrawer(state: RoomState, now: number, random: () => number): boolean {
  const current = state.current;
  if (state.phase !== "awaiting_ready" || !current || current.readyDeadlineAt > now) return false;
  const replacement = chooseNextDrawer(state, current.drawerId, random);
  state.current = createTurn(state, current.round, replacement.id, now);
  state.updatedAt = now;
  return true;
}

export function expireArmedTurn(state: RoomState, now: number, random: () => number): boolean {
  const current = state.current;
  if (state.phase !== "armed" || !current || current.armedDeadlineAt === null || current.armedDeadlineAt > now) return false;
  current.winnerId = null;
  current.nextDrawerId = chooseNextDrawer(state, current.drawerId, random).id;
  reveal(state, now);
  return true;
}

export function appendStroke(
  state: RoomState,
  terminalSessionId: string,
  stroke: Stroke,
  now: number,
): AppendStrokeResult {
  const current = state.current;
  if (!current || current.drawerTerminalSessionId !== terminalSessionId || !["armed", "drawing"].includes(state.phase)) {
    throw new GameRuleError("Le dessin n’est pas autorisé.");
  }
  if (current.deadlineAt !== null && now >= current.deadlineAt) {
    expireTurn(state, now);
    throw new GameRuleError("Le temps est écoulé.");
  }
  prepareTurnDrawingState(current);
  let deadline: number | null = null;
  if (state.phase === "armed") {
    state.phase = "drawing";
    current.armedDeadlineAt = null;
    current.startedAt = now;
    current.deadlineAt = now + state.settings.durationSeconds * 1000;
    deadline = current.deadlineAt;
  }

  const incoming = normaliseStroke(stroke);
  const existing = current.strokes.find((candidate) => candidate.id === incoming.id);
  if (current.pointCount + incoming.points.length > MAX_POINTS_PER_TURN) {
    throw new GameRuleError("La limite de points pour ce tour est atteinte.");
  }
  if (existing) {
    if (existing.complete || existing.tool !== incoming.tool || existing.width !== incoming.width) {
      throw new GameRuleError("Trait invalide.");
    }
    if (existing.points.length + incoming.points.length > MAX_POINTS_PER_STROKE) {
      throw new GameRuleError("Ce trait contient trop de points.");
    }
    existing.points.push(...incoming.points);
    existing.complete ||= incoming.complete;
  } else {
    if (current.strokes.length >= MAX_STROKES_PER_TURN || incoming.points.length > MAX_POINTS_PER_STROKE) {
      throw new GameRuleError("La limite de traits pour ce tour est atteinte.");
    }
    current.strokes.push(incoming);
    current.redoStrokes = [];
  }
  current.pointCount += incoming.points.length;
  state.updatedAt = now;
  return { deadlineAt: deadline, stroke: incoming };
}

function assertActiveTurn(state: RoomState): CurrentTurn {
  if (!state.current || !["armed", "drawing", "revealing"].includes(state.phase)) {
    throw new GameRuleError("Aucun tour en cours.");
  }
  return state.current;
}

export function undo(state: RoomState, terminalSessionId: string, now: number): void {
  const current = assertActiveTurn(state);
  if (current.drawerTerminalSessionId !== terminalSessionId || state.phase === "revealing") throw new GameRuleError("Action non autorisée.");
  if (current.deadlineAt !== null && now >= current.deadlineAt) {
    expireTurn(state, now);
    throw new GameRuleError("Le temps est écoulé.");
  }
  prepareTurnDrawingState(current);
  const removed = current.strokes.pop();
  if (removed) {
    current.redoStrokes.push(removed);
    current.pointCount -= removed.points.length;
  }
  state.updatedAt = now;
}

export function redo(state: RoomState, terminalSessionId: string, now: number): void {
  const current = assertActiveTurn(state);
  if (current.drawerTerminalSessionId !== terminalSessionId || state.phase === "revealing") throw new GameRuleError("Action non autorisée.");
  if (current.deadlineAt !== null && now >= current.deadlineAt) {
    expireTurn(state, now);
    throw new GameRuleError("Le temps est écoulé.");
  }
  prepareTurnDrawingState(current);
  const restored = current.redoStrokes.pop();
  if (restored) {
    current.strokes.push(restored);
    current.pointCount += restored.points.length;
  }
  state.updatedAt = now;
}

export function clear(state: RoomState, terminalSessionId: string, now: number): void {
  const current = assertActiveTurn(state);
  if (current.drawerTerminalSessionId !== terminalSessionId || state.phase === "revealing") throw new GameRuleError("Action non autorisée.");
  if (current.deadlineAt !== null && now >= current.deadlineAt) {
    expireTurn(state, now);
    throw new GameRuleError("Le temps est écoulé.");
  }
  prepareTurnDrawingState(current);
  current.strokes = [];
  current.redoStrokes = [];
  current.pointCount = 0;
  state.updatedAt = now;
}

function reveal(state: RoomState, now: number): void {
  const current = assertActiveTurn(state);
  current.revealedAt = now;
  state.phase = "revealing";
  state.updatedAt = now;
}

export function selectWinner(state: RoomState, terminalSessionId: string, winnerId: string, now: number): void {
  const current = state.current;
  if (state.phase !== "drawing" || !current) throw new GameRuleError("Le tour n’est plus en cours.");
  assertDrawerTerminal(state, terminalSessionId);
  if (current.drawerId === winnerId) throw new GameRuleError("Le dessinateur ne peut pas valider son propre point.");
  const winner = getPlayer(state, winnerId);
  const drawer = getPlayer(state, current.drawerId);
  winner.score += 1;
  drawer.score += 1;
  current.winnerId = winnerId;
  current.nextDrawerId = winnerId;
  reveal(state, now);
}

export function noWinner(state: RoomState, terminalSessionId: string, now: number, random: () => number): void {
  const current = state.current;
  if (state.phase !== "drawing" || !current) throw new GameRuleError("Le tour n’est plus en cours.");
  assertDrawerTerminal(state, terminalSessionId);
  current.winnerId = null;
  current.nextDrawerId = chooseNextDrawer(state, current.drawerId, random).id;
  reveal(state, now);
}

export function expireTurn(state: RoomState, now: number, random: () => number = () => 0): boolean {
  if (state.phase !== "drawing" || !state.current?.deadlineAt || state.current.deadlineAt > now) return false;
  state.current.winnerId = null;
  state.current.nextDrawerId = chooseNextDrawer(state, state.current.drawerId, random).id;
  reveal(state, now);
  return true;
}

export function nextTurn(state: RoomState, now: number): void {
  const current = state.current;
  if (state.phase !== "revealing" || !current || !current.nextDrawerId) {
    throw new GameRuleError("Le tour en cours doit d’abord être révélé.");
  }
  if (current.round >= state.settings.rounds) {
    const bestScore = Math.max(...state.players.map((player) => player.score));
    state.finishedWinnerIds = state.players.filter((player) => player.score === bestScore).map((player) => player.id);
    state.phase = "finished";
    state.updatedAt = now;
    return;
  }
  state.current = createTurn(state, current.round + 1, current.nextDrawerId, now);
  state.phase = "awaiting_ready";
  state.updatedAt = now;
}

export function snapshotFor(state: RoomState, session: Session, now: number): RoomSnapshot {
  const current = state.current;
  const drawer = current ? getPlayer(state, current.drawerId) : null;
  const revealed = state.phase === "revealing" || state.phase === "finished";
  return {
    code: state.code,
    phase: state.phase,
    settings: structuredClone(state.settings),
    players: structuredClone(state.players),
    turn: current && drawer ? {
      id: current.id,
      round: current.round,
      drawerId: current.drawerId,
      drawerName: drawer.name,
      readyDeadlineAt: current.readyDeadlineAt,
      armedDeadlineAt: current.armedDeadlineAt,
      deadlineAt: current.deadlineAt,
      revealedWord: revealed ? current.word?.label ?? null : null,
      strokes: structuredClone(current.strokes),
      winnerId: current.winnerId,
      nextDrawerId: current.nextDrawerId,
    } : null,
    canDraw: session.role === "terminal" && session.id === current?.drawerTerminalSessionId && ["awaiting_ready", "armed", "drawing"].includes(state.phase),
    canTakeDrawingTurn: session.role === "terminal" && state.phase === "awaiting_ready" && (!current?.drawerTerminalSessionId || current.drawerTerminalSessionId === session.id),
    canSelectWinner: session.role === "terminal" && session.id === current?.drawerTerminalSessionId && state.phase === "drawing",
    secretWord: session.role === "terminal" && session.id === current?.drawerTerminalSessionId && ["armed", "drawing"].includes(state.phase)
      ? current?.word?.label ?? null
      : null,
    finishedWinnerIds: structuredClone(state.finishedWinnerIds),
    serverNow: now,
  };
}
