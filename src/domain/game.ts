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

const newTurn = (round: number, drawerId: string, sequence: number): CurrentTurn => ({
  id: `turn-${sequence}`,
  round,
  drawerId,
  word: null,
  strokes: [],
  redoStrokes: [],
  pointCount: 0,
  startedAt: null,
  deadlineAt: null,
  revealedAt: null,
  winnerId: null,
  nextDrawerId: null,
  resolutionPending: false,
});

const createTurn = (state: RoomState, round: number, drawerId: string): CurrentTurn => {
  state.turnSequence = (state.turnSequence ?? 0) + 1;
  return newTurn(round, drawerId, state.turnSequence);
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
  if (state.players.length < 2) throw new GameRuleError("Il faut au moins deux joueurs.");
  const drawer = chooseRandom(state.players, random);
  state.current = createTurn(state, 1, drawer.id);
  state.phase = "awaiting_ready";
  state.updatedAt = now;
}

export function ready(state: RoomState, playerId: string, now: number, random: () => number): void {
  if (state.phase !== "awaiting_ready" || state.current?.drawerId !== playerId) {
    throw new GameRuleError("Seul le dessinateur désigné peut se déclarer prêt.");
  }
  state.current.word = chooseWord(state, random);
  state.phase = "armed";
  state.updatedAt = now;
}

export function appendStroke(
  state: RoomState,
  playerId: string,
  stroke: Stroke,
  now: number,
): AppendStrokeResult {
  const current = state.current;
  if (!current || current.drawerId !== playerId || !["armed", "drawing"].includes(state.phase)) {
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

export function undo(state: RoomState, playerId: string, now: number): void {
  const current = assertActiveTurn(state);
  if (current.drawerId !== playerId || state.phase === "revealing") throw new GameRuleError("Action non autorisée.");
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

export function redo(state: RoomState, playerId: string, now: number): void {
  const current = assertActiveTurn(state);
  if (current.drawerId !== playerId || state.phase === "revealing") throw new GameRuleError("Action non autorisée.");
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

export function clear(state: RoomState, playerId: string, now: number): void {
  const current = assertActiveTurn(state);
  if (current.drawerId !== playerId || state.phase === "revealing") throw new GameRuleError("Action non autorisée.");
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
  current.resolutionPending = true;
  state.phase = "revealing";
  state.updatedAt = now;
}

export function expireTurn(state: RoomState, now: number): boolean {
  if (state.phase !== "drawing" || !state.current?.deadlineAt || state.current.deadlineAt > now) return false;
  reveal(state, now);
  return true;
}

function beginResolution(state: RoomState, now: number): CurrentTurn {
  if (!state.current || !["drawing", "revealing"].includes(state.phase)) {
    throw new GameRuleError("Le résultat ne peut pas encore être validé.");
  }
  if (state.phase !== "revealing") reveal(state, now);
  if (!state.current.resolutionPending) throw new GameRuleError("Le résultat de ce tour est déjà validé.");
  return state.current;
}

export function selectWinner(state: RoomState, winnerId: string, now: number): void {
  const current = beginResolution(state, now);
  if (current.drawerId === winnerId) throw new GameRuleError("Le dessinateur ne peut pas gagner son propre tour.");
  getPlayer(state, winnerId);
  const winner = getPlayer(state, winnerId);
  const drawer = getPlayer(state, current.drawerId);
  winner.score += 1;
  drawer.score += 1;
  current.winnerId = winnerId;
  current.nextDrawerId = winnerId;
  current.resolutionPending = false;
  state.updatedAt = now;
}

export function selectNoWinner(state: RoomState, now: number, random: () => number): void {
  const current = beginResolution(state, now);
  current.winnerId = null;
  current.nextDrawerId = chooseRandom(availablePlayers(state, current.drawerId), random).id;
  current.resolutionPending = false;
  state.updatedAt = now;
}

export function cancelTurn(state: RoomState, now: number): void {
  const current = state.current;
  if (!current || !["awaiting_ready", "armed", "drawing", "revealing"].includes(state.phase)) {
    throw new GameRuleError("Aucun tour à annuler.");
  }
  if (state.phase === "revealing" && !current.resolutionPending) {
    throw new GameRuleError("Le résultat de ce tour est déjà validé.");
  }
  state.current = createTurn(state, current.round, current.drawerId);
  state.phase = "awaiting_ready";
  state.updatedAt = now;
}

export function nextTurn(state: RoomState, now: number): void {
  const current = state.current;
  if (state.phase !== "revealing" || !current || current.resolutionPending || !current.nextDrawerId) {
    throw new GameRuleError("Validez d’abord le résultat du tour.");
  }
  if (current.round >= state.settings.rounds) {
    const bestScore = Math.max(...state.players.map((player) => player.score));
    state.finishedWinnerIds = state.players.filter((player) => player.score === bestScore).map((player) => player.id);
    state.phase = "finished";
    state.updatedAt = now;
    return;
  }
  state.current = createTurn(state, current.round + 1, current.nextDrawerId);
  state.phase = "awaiting_ready";
  state.updatedAt = now;
}

export function endGame(state: RoomState, now: number): void {
  const bestScore = Math.max(...state.players.map((player) => player.score));
  state.finishedWinnerIds = state.players.filter((player) => player.score === bestScore).map((player) => player.id);
  state.phase = "finished";
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
      deadlineAt: current.deadlineAt,
      revealedWord: revealed ? current.word?.label ?? null : null,
      strokes: structuredClone(current.strokes),
      winnerId: current.winnerId,
      nextDrawerId: current.nextDrawerId,
      resolutionPending: current.resolutionPending,
    } : null,
    canDraw: session.role === "player" && session.playerId === current?.drawerId && ["awaiting_ready", "armed", "drawing"].includes(state.phase),
    secretWord: session.role === "player" && session.playerId === current?.drawerId && ["armed", "drawing"].includes(state.phase)
      ? current?.word?.label ?? null
      : null,
    isController: session.role === "controller",
    controllerResolutionPending: session.role === "controller" && state.phase === "revealing" && Boolean(current?.resolutionPending),
    finishedWinnerIds: structuredClone(state.finishedWinnerIds),
    serverNow: now,
  };
}
