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

const newTurn = (round: number, drawerId: string): CurrentTurn => ({
  round,
  drawerId,
  word: null,
  strokes: [],
  startedAt: null,
  deadlineAt: null,
  revealedAt: null,
  winnerId: null,
  nextDrawerId: null,
  resolutionPending: false,
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
  state.current = newTurn(1, drawer.id);
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
): number | null {
  const current = state.current;
  if (!current || current.drawerId !== playerId || !["armed", "drawing"].includes(state.phase)) {
    throw new GameRuleError("Le dessin n’est pas autorisé.");
  }
  let deadline: number | null = null;
  if (state.phase === "armed") {
    state.phase = "drawing";
    current.startedAt = now;
    current.deadlineAt = now + state.settings.durationSeconds * 1000;
    deadline = current.deadlineAt;
  }

  const existing = current.strokes.find((candidate) => candidate.id === stroke.id);
  if (existing) {
    if (existing.tool !== stroke.tool || existing.width !== stroke.width) throw new GameRuleError("Trait invalide.");
    existing.points.push(...stroke.points);
    existing.complete ||= stroke.complete;
  } else {
    current.strokes.push(structuredClone(stroke));
  }
  state.updatedAt = now;
  return deadline;
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
  current.strokes.pop();
  state.updatedAt = now;
}

export function clear(state: RoomState, playerId: string, now: number): void {
  const current = assertActiveTurn(state);
  if (current.drawerId !== playerId || state.phase === "revealing") throw new GameRuleError("Action non autorisée.");
  current.strokes = [];
  state.updatedAt = now;
}

function reveal(state: RoomState, now: number): void {
  const current = assertActiveTurn(state);
  current.revealedAt = now;
  current.resolutionPending = true;
  state.phase = "revealing";
  state.updatedAt = now;
}

export function expireTurn(state: RoomState, now: number): void {
  if (state.phase !== "drawing") return;
  reveal(state, now);
}

export function selectWinner(state: RoomState, winnerId: string, now: number): void {
  const current = assertActiveTurn(state);
  if (current.drawerId === winnerId) throw new GameRuleError("Le dessinateur ne peut pas gagner son propre tour.");
  getPlayer(state, winnerId);
  if (state.phase !== "revealing") reveal(state, now);
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
  const current = assertActiveTurn(state);
  if (state.phase !== "revealing") reveal(state, now);
  current.nextDrawerId = chooseRandom(availablePlayers(state, current.drawerId), random).id;
  current.resolutionPending = false;
  state.updatedAt = now;
}

export function cancelTurn(state: RoomState, now: number): void {
  const current = assertActiveTurn(state);
  state.current = newTurn(current.round, current.drawerId);
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
  state.current = newTurn(current.round + 1, current.nextDrawerId);
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
