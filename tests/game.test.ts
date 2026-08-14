import { describe, expect, it } from "vitest";
import {
  addPlayer,
  appendStroke,
  clear,
  createRoomState,
  expireArmedTurn,
  expireReadyDrawer,
  expireTurn,
  GameRuleError,
  MAX_POINTS_PER_STROKE,
  nextTurn,
  noWinner,
  removePlayer,
  redo,
  ready,
  returnToLobby,
  selectWinner,
  setTerminalDisplayMode,
  snapshotFor,
  startGame,
  takeDrawingTurn,
  undo,
} from "../src/domain/game";
import { CATALOGUE, CATALOGUE_SIZE, wordIdFor } from "../src/domain/catalogue";
import dictionary from "../src/domain/data/dictionary.fr.json";
import { DEFAULT_SETTINGS, type Difficulty, type Player, type RoomState, type Session } from "../src/domain/types";

const controller: Session = { id: "controller", token: "controller-token", role: "controller", createdAt: 0, lastSeenAt: 0 };
const terminal: Session = { id: "terminal", token: "terminal-token", role: "terminal", createdAt: 0, lastSeenAt: 0 };
const player = (id: string, name: string): Player => ({ id, name, score: 0, joinedAt: 0 });
const deterministic = (): number => 0;
const canvasRevision = (state: RoomState): number => state.current?.canvasRevision ?? 0;

function startedRoom() {
  const state = createRoomState("ABC123", controller, 0);
  addPlayer(state, player("player-1", "Lila"), 1);
  addPlayer(state, player("player-2", "Noé"), 1);
  startGame(state, DEFAULT_SETTINGS, 2, deterministic);
  takeDrawingTurn(state, terminal.id, 2);
  return state;
}

describe("moteur de jeu", () => {
  it("propose un catalogue riche et équilibré dans chaque thème et difficulté", () => {
    expect(CATALOGUE_SIZE).toBeGreaterThanOrEqual(1_125);
    expect(new Set(CATALOGUE.map((word) => word.id)).size).toBe(CATALOGUE_SIZE);
    expect(wordIdFor("chat", "animaux", "facile")).toBe("word-animaux-facile-b2d9f03309ab4a92");
    expect(wordIdFor("chat", "animaux", "facile")).not.toBe(wordIdFor("chat", "animaux", "moyen"));
    const labelsByDifficulty = new Map<Difficulty, string[]>();
    for (const theme of ["animaux", "objets", "alimentation", "lieux", "metiers"] as const) {
      const themeLabels: string[] = [];
      for (const difficulty of ["facile", "moyen", "difficile"] as const) {
        const labels = CATALOGUE
          .filter((word) => word.theme === theme && word.difficulty === difficulty)
          .map((word) => word.label);
        expect(labels).toEqual(dictionary.prompts[theme][difficulty]);
        expect(labels.length).toBeGreaterThanOrEqual(75);
        labelsByDifficulty.set(difficulty, [...(labelsByDifficulty.get(difficulty) ?? []), ...labels]);
        themeLabels.push(...labels);
      }
      expect(new Set(themeLabels.map((label) => label.toLocaleLowerCase("fr"))).size).toBe(themeLabels.length);
    }
    for (const labels of labelsByDifficulty.values()) {
      expect(new Set(labels.map((label) => label.toLocaleLowerCase("fr"))).size).toBe(labels.length);
    }
  });

  it("applique les réglages avec le démarrage et permet de retirer un joueur seulement au lobby", () => {
    const state = createRoomState("ATOMIC", controller, 0);
    addPlayer(state, player("player-1", "Lila"), 1);
    addPlayer(state, player("player-2", "Noé"), 1);
    removePlayer(state, "player-2", 2);

    const difficultSettings = { ...DEFAULT_SETTINGS, durationSeconds: 30 as const, rounds: 5 as const, difficulty: "difficile" as const };
    startGame(state, difficultSettings, 3, deterministic);

    expect(state.settings).toEqual(difficultSettings);
    expect(state.players.map((candidate) => candidate.name)).toEqual(["Lila"]);
    expect(() => removePlayer(state, "player-1", 4)).toThrow("Les inscriptions sont fermées.");
    takeDrawingTurn(state, terminal.id, 4);
    ready(state, terminal.id, 5, deterministic);
    expect(state.current?.word?.difficulty).toBe("difficile");
  });

  it("ne modifie pas la partie si les réglages du démarrage sont invalides", () => {
    const state = createRoomState("INVALID", controller, 0);
    addPlayer(state, player("player-1", "Lila"), 1);

    expect(() => startGame(state, { ...DEFAULT_SETTINGS, difficulty: "inconnue" as Difficulty }, 2, deterministic)).toThrow("Choisissez une difficulté valide.");
    expect(state.phase).toBe("lobby");
    expect(state.current).toBeNull();
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("autorise une partie à un seul joueur et le même joueur au tour suivant", () => {
    const state = createRoomState("SOLO01", controller, 0);
    addPlayer(state, player("player-1", "Lila"), 1);
    startGame(state, DEFAULT_SETTINGS, 2, deterministic);
    takeDrawingTurn(state, terminal.id, 2);
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, canvasRevision(state), {
      id: "solo-stroke", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);

    expect(expireTurn(state, 60_005)).toBe(true);
    expect(state.phase).toBe("resolving");
    noWinner(state, terminal.id, 60_006, deterministic);
    expect(state.current?.nextDrawerId).toBe("player-1");
  });

  it("associe le terminal au tour, sans l’associer au joueur", () => {
    const state = startedRoom();
    const otherTerminal: Session = { id: "other-terminal", token: "token", role: "terminal", createdAt: 0, lastSeenAt: 0 };

    expect(() => ready(state, otherTerminal.id, 3, deterministic)).toThrow(GameRuleError);
    expect(snapshotFor(state, terminal, 3).canDraw).toBe(true);
    expect(snapshotFor(state, otherTerminal, 3).canDraw).toBe(false);
  });

  it("remplace automatiquement un dessinateur qui ne se déclare pas prêt", () => {
    const state = startedRoom();
    const originalTurnId = state.current?.id;

    expect(expireReadyDrawer(state, 30_002, deterministic)).toBe(true);
    expect(state.phase).toBe("awaiting_ready");
    expect(state.current?.id).not.toBe(originalTurnId);
    expect(state.current?.drawerId).toBe("player-2");
  });

  it("révèle puis enchaîne si le dessinateur ne commence pas son dessin", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);

    expect(expireArmedTurn(state, 30_003, deterministic)).toBe(true);
    expect(state.phase).toBe("revealing");
    expect(state.current?.winnerId).toBeNull();
    expect(state.current?.nextDrawerId).toBe("player-2");
  });

  it("laisse le dessinateur interrompre la manche dès que le mot est prêt", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);

    expect(state.phase).toBe("armed");
    expect(snapshotFor(state, terminal, 3).canSelectWinner).toBe(true);
    selectWinner(state, terminal.id, "player-2", 4);

    expect(state.phase).toBe("revealing");
    expect(state.current?.strokes).toHaveLength(0);
    expect(state.current?.nextDrawerId).toBe("player-2");
  });

  it("démarre le chrono au premier trait, puis attribue les points au premier joueur qui valide", () => {
    const state = startedRoom();
    expect(state.phase).toBe("awaiting_ready");
    expect(state.current?.drawerId).toBe("player-1");

    ready(state, terminal.id, 3, deterministic);
    expect(state.phase).toBe("armed");
    expect(state.current?.word).not.toBeNull();

    const appendResult = appendStroke(state, terminal.id, canvasRevision(state), {
      id: "stroke-0001",
      tool: "pen",
      width: 8,
      points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }],
      complete: true,
    }, 5);
    expect(appendResult.deadlineAt).toBe(60_005);
    expect(state.phase).toBe("drawing");

    selectWinner(state, terminal.id, "player-2", 7);
    expect(state.phase).toBe("revealing");
    expect(state.players.map((candidate) => candidate.score)).toEqual([1, 1]);
    expect(state.current?.nextDrawerId).toBe("player-2");

    nextTurn(state, 8);
    expect(state.phase).toBe("awaiting_ready");
    expect(state.current?.round).toBe(2);
    expect(state.current?.drawerId).toBe("player-2");
  });

  it("arrête le dessin au délai et laisse le dessinateur désigner le gagnant suivant", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, canvasRevision(state), {
      id: "stroke-0002", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);
    expireTurn(state, 60_005);
    expect(state.phase).toBe("resolving");
    expect(state.current?.winnerId).toBeNull();
    expect(state.current?.nextDrawerId).toBeNull();
    expect(state.players.map((candidate) => candidate.score)).toEqual([0, 0]);
    expect(snapshotFor(state, terminal, 60_005).canSelectWinner).toBe(true);

    selectWinner(state, terminal.id, "player-2", 60_006);
    expect(state.phase).toBe("revealing");
    expect(state.current?.winnerId).toBe("player-2");
    expect(state.current?.nextDrawerId).toBe("player-2");
    expect(state.players.map((candidate) => candidate.score)).toEqual([1, 1]);

    nextTurn(state, 60_010);
    expect(state.phase).toBe("awaiting_ready");
    expect(state.current?.drawerId).toBe("player-2");
  });

  it("tire le prochain dessinateur au sort seulement quand le dessinateur choisit aucun gagnant", () => {
    const state = createRoomState("RANDOM", controller, 0);
    addPlayer(state, player("player-1", "Lila"), 1);
    addPlayer(state, player("player-2", "Noé"), 1);
    addPlayer(state, player("player-3", "Maya"), 1);
    startGame(state, DEFAULT_SETTINGS, 2, deterministic);
    takeDrawingTurn(state, terminal.id, 2);
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, canvasRevision(state), {
      id: "stroke-timeout-none", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);

    expect(expireTurn(state, 60_005)).toBe(true);
    expect(state.current?.nextDrawerId).toBeNull();
    noWinner(state, terminal.id, 60_006, () => 0.99);

    expect(state.phase).toBe("revealing");
    expect(state.current?.winnerId).toBeNull();
    expect(state.current?.nextDrawerId).toBe("player-3");
    expect(state.players.map((candidate) => candidate.score)).toEqual([0, 0, 0]);
  });

  it("permet au dessinateur de clôturer immédiatement un tour sans gagnant", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, canvasRevision(state), {
      id: "stroke-no-winner", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);

    noWinner(state, terminal.id, 7, deterministic);

    expect(state.phase).toBe("revealing");
    expect(state.current?.winnerId).toBeNull();
    expect(state.current?.nextDrawerId).toBe("player-2");
    expect(state.players.map((candidate) => candidate.score)).toEqual([0, 0]);
  });

  it("ne divulgue le mot qu’au dessinateur avant la révélation", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    const drawerSession: Session = terminal;
    const otherSession: Session = { id: "other-session", token: "token", role: "terminal", createdAt: 0, lastSeenAt: 0 };
    const controllerSession: Session = { id: "controller-session", token: "token", role: "controller", createdAt: 0, lastSeenAt: 0 };
    expect(snapshotFor(state, drawerSession, 4).secretWord).toBeTruthy();
    expect(snapshotFor(state, otherSession, 4).secretWord).toBeNull();
    expect(snapshotFor(state, controllerSession, 4).secretWord).toBeNull();
  });

  it("permet à un terminal libre de devenir projecteur sans lui donner le mot secret", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    const otherTerminal: Session = { id: "projector-terminal", token: "token", role: "terminal", createdAt: 0, lastSeenAt: 0 };

    setTerminalDisplayMode(state, otherTerminal, "projection", 4);
    const projection = snapshotFor(state, otherTerminal, 4);
    expect(projection.displayMode).toBe("projection");
    expect(projection.secretWord).toBeNull();
    expect(projection.canTakeDrawingTurn).toBe(false);

    expect(() => setTerminalDisplayMode(state, terminal, "projection", 4)).toThrow("Le terminal de dessin actif ne peut pas passer en mode projecteur.");
    setTerminalDisplayMode(state, otherTerminal, "drawing", 5);
    expect(snapshotFor(state, otherTerminal, 5).displayMode).toBe("drawing");
  });

  it("refuse une seconde validation du dessinateur et ne double jamais les points", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, canvasRevision(state), {
      id: "stroke-0003", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);
    selectWinner(state, terminal.id, "player-2", 7);

    expect(() => selectWinner(state, terminal.id, "player-2", 8)).toThrow(GameRuleError);
    expect(state.players.map((candidate) => candidate.score)).toEqual([1, 1]);
  });

  it("prépare une nouvelle partie sans réutiliser les identifiants de tour", () => {
    const state = startedRoom();
    const previousTurnSequence = state.turnSequence;
    state.players[0]!.score = 4;
    state.players[1]!.score = 2;
    state.usedWordIds = ["animaux-chat-facile"];
    state.finishedWinnerIds = [state.players[0]!.id];
    state.phase = "finished";

    returnToLobby(state, 42);

    expect(state.phase).toBe("lobby");
    expect(state.current).toBeNull();
    expect(state.players.map((candidate) => ({ name: candidate.name, score: candidate.score }))).toEqual([
      { name: "Lila", score: 0 },
      { name: "Noé", score: 0 },
    ]);
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.usedWordIds).toEqual([]);
    expect(state.finishedWinnerIds).toEqual([]);
    expect(state.turnSequence).toBe(previousTurnSequence);
    expect(state.updatedAt).toBe(42);

    startGame(state, DEFAULT_SETTINGS, 43, deterministic);
    expect(state.current?.id).toBe(`turn-${previousTurnSequence + 1}`);
  });

  it("refuse de préparer une nouvelle partie avant le résultat final", () => {
    expect(() => returnToLobby(startedRoom(), 10)).toThrow("La partie n’est pas terminée.");
  });

  it("arrête le dessin à l’échéance et permet de rétablir un trait annulé", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, canvasRevision(state), {
      id: "stroke-0004", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);
    undo(state, terminal.id, 6);
    expect(state.current?.strokes).toHaveLength(0);
    redo(state, terminal.id, 7);
    expect(state.current?.strokes).toHaveLength(1);

    expect(expireTurn(state, 60_004)).toBe(false);
    expect(() => appendStroke(state, terminal.id, canvasRevision(state), {
      id: "stroke-0005", tool: "pen", width: 8, points: [{ x: 0.2, y: 0.2 }], complete: true,
    }, 60_005)).toThrow("Le temps est écoulé.");
    expect(state.phase).toBe("resolving");
    expect(snapshotFor(state, terminal, 60_005).canDraw).toBe(false);
    expect(() => undo(state, terminal.id, 60_006)).toThrow("Aucun tour en cours.");
  });

  it("rejette un fragment retardé après une remise à zéro du canevas", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    const initialRevision = canvasRevision(state);
    const first = appendStroke(state, terminal.id, initialRevision, {
      id: "stroke-delayed", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: false,
    }, 5);
    expect(first.offset).toBe(0);

    const second = appendStroke(state, terminal.id, initialRevision, {
      id: "stroke-delayed", tool: "pen", width: 8, points: [{ x: 0.2, y: 0.2 }], complete: false,
    }, 6);
    expect(second.offset).toBe(1);

    clear(state, terminal.id, 7);
    expect(canvasRevision(state)).toBe(initialRevision + 1);
    expect(() => appendStroke(state, terminal.id, initialRevision, {
      id: "stroke-delayed", tool: "pen", width: 8, points: [{ x: 0.3, y: 0.3 }], complete: true,
    }, 8)).toThrow("Cette commande concerne une ancienne version du dessin.");
    expect(state.current?.strokes).toEqual([]);
  });

  it("borne le volume du canevas sur un tour", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    const points = Array.from({ length: MAX_POINTS_PER_STROKE }, (_, index) => ({ x: index / MAX_POINTS_PER_STROKE, y: 0.5 }));
    for (let index = 0; index < 7; index += 1) {
      appendStroke(state, terminal.id, canvasRevision(state), {
        id: `stroke-limit-${index}`, tool: "pen", width: 8, points, complete: true,
      }, 5 + index);
    }
    expect(() => appendStroke(state, terminal.id, canvasRevision(state), {
      id: "stroke-limit-overflow", tool: "pen", width: 8, points, complete: true,
    }, 20)).toThrow("La limite de points pour ce tour est atteinte.");
  });
});
