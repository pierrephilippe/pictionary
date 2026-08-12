import { describe, expect, it } from "vitest";
import {
  addPlayer,
  appendStroke,
  createRoomState,
  expireArmedTurn,
  expireReadyDrawer,
  expireTurn,
  GameRuleError,
  MAX_POINTS_PER_STROKE,
  nextTurn,
  noWinner,
  redo,
  ready,
  selectWinner,
  snapshotFor,
  startGame,
  takeDrawingTurn,
  undo,
} from "../src/domain/game";
import type { Player, Session } from "../src/domain/types";

const controller: Session = { id: "controller", token: "controller-token", role: "controller", createdAt: 0, lastSeenAt: 0 };
const terminal: Session = { id: "terminal", token: "terminal-token", role: "terminal", createdAt: 0, lastSeenAt: 0 };
const player = (id: string, name: string): Player => ({ id, name, score: 0, joinedAt: 0 });
const deterministic = (): number => 0;

function startedRoom() {
  const state = createRoomState("ABC123", controller, 0);
  addPlayer(state, player("player-1", "Lila"), 1);
  addPlayer(state, player("player-2", "Noé"), 1);
  startGame(state, 2, deterministic);
  takeDrawingTurn(state, terminal.id, 2);
  return state;
}

describe("moteur de jeu", () => {
  it("autorise une partie à un seul joueur et le même joueur au tour suivant", () => {
    const state = createRoomState("SOLO01", controller, 0);
    addPlayer(state, player("player-1", "Lila"), 1);
    startGame(state, 2, deterministic);
    takeDrawingTurn(state, terminal.id, 2);
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, {
      id: "solo-stroke", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);

    expect(expireTurn(state, 60_005, deterministic)).toBe(true);
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

  it("démarre le chrono au premier trait, puis attribue les points au premier joueur qui valide", () => {
    const state = startedRoom();
    expect(state.phase).toBe("awaiting_ready");
    expect(state.current?.drawerId).toBe("player-1");

    ready(state, terminal.id, 3, deterministic);
    expect(state.phase).toBe("armed");
    expect(state.current?.word).not.toBeNull();

    const appendResult = appendStroke(state, terminal.id, {
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

  it("révèle le mot au délai et tire un autre dessinateur sans gagnant", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, {
      id: "stroke-0002", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);
    expireTurn(state, 60_005);
    expect(state.phase).toBe("revealing");
    expect(state.current?.winnerId).toBeNull();
    expect(state.current?.nextDrawerId).toBe("player-2");
    expect(state.players.map((candidate) => candidate.score)).toEqual([0, 0]);

    nextTurn(state, 60_010);
    expect(state.phase).toBe("awaiting_ready");
    expect(state.current?.drawerId).toBe("player-2");
  });

  it("permet au dessinateur de clôturer immédiatement un tour sans gagnant", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, {
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

  it("refuse une seconde validation du dessinateur et ne double jamais les points", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, {
      id: "stroke-0003", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);
    selectWinner(state, terminal.id, "player-2", 7);

    expect(() => selectWinner(state, terminal.id, "player-2", 8)).toThrow(GameRuleError);
    expect(state.players.map((candidate) => candidate.score)).toEqual([1, 1]);
  });

  it("arrête le dessin à l’échéance et permet de rétablir un trait annulé", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    appendStroke(state, terminal.id, {
      id: "stroke-0004", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);
    undo(state, terminal.id, 6);
    expect(state.current?.strokes).toHaveLength(0);
    redo(state, terminal.id, 7);
    expect(state.current?.strokes).toHaveLength(1);

    expect(expireTurn(state, 60_004)).toBe(false);
    expect(() => appendStroke(state, terminal.id, {
      id: "stroke-0005", tool: "pen", width: 8, points: [{ x: 0.2, y: 0.2 }], complete: true,
    }, 60_005)).toThrow("Le temps est écoulé.");
    expect(state.phase).toBe("revealing");
  });

  it("borne le volume du canevas sur un tour", () => {
    const state = startedRoom();
    ready(state, terminal.id, 3, deterministic);
    const points = Array.from({ length: MAX_POINTS_PER_STROKE }, (_, index) => ({ x: index / MAX_POINTS_PER_STROKE, y: 0.5 }));
    for (let index = 0; index < 7; index += 1) {
      appendStroke(state, terminal.id, {
        id: `stroke-limit-${index}`, tool: "pen", width: 8, points, complete: true,
      }, 5 + index);
    }
    expect(() => appendStroke(state, terminal.id, {
      id: "stroke-limit-overflow", tool: "pen", width: 8, points, complete: true,
    }, 20)).toThrow("La limite de points pour ce tour est atteinte.");
  });
});
