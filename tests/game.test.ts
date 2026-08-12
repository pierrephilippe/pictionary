import { describe, expect, it } from "vitest";
import {
  addPlayer,
  appendStroke,
  cancelTurn,
  createRoomState,
  expireTurn,
  GameRuleError,
  MAX_POINTS_PER_STROKE,
  nextTurn,
  redo,
  ready,
  selectNoWinner,
  selectWinner,
  snapshotFor,
  startGame,
  undo,
} from "../src/domain/game";
import type { Player, Session } from "../src/domain/types";

const controller: Session = { id: "controller", token: "controller-token", role: "controller", createdAt: 0 };
const player = (id: string, name: string): Player => ({ id, name, score: 0, joinedAt: 0 });
const deterministic = (): number => 0;

function startedRoom() {
  const state = createRoomState("ABC123", controller, 0);
  addPlayer(state, player("player-1", "Lila"), 1);
  addPlayer(state, player("player-2", "Noé"), 1);
  startGame(state, 2, deterministic);
  return state;
}

describe("moteur de jeu", () => {
  it("démarre le chrono au premier trait, révèle le mot et donne les deux points", () => {
    const state = startedRoom();
    expect(state.phase).toBe("awaiting_ready");
    expect(state.current?.drawerId).toBe("player-1");

    ready(state, "player-1", 3, deterministic);
    expect(state.phase).toBe("armed");
    expect(state.current?.word).not.toBeNull();

    const appendResult = appendStroke(state, "player-1", {
      id: "stroke-0001",
      tool: "pen",
      width: 8,
      points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }],
      complete: true,
    }, 5);
    expect(appendResult.deadlineAt).toBe(60_005);
    expect(state.phase).toBe("drawing");

    selectWinner(state, "player-2", 7);
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
    ready(state, "player-1", 3, deterministic);
    appendStroke(state, "player-1", {
      id: "stroke-0002", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);
    expireTurn(state, 60_005);
    expect(state.phase).toBe("revealing");
    expect(state.current?.resolutionPending).toBe(true);

    selectNoWinner(state, 60_006, deterministic);
    expect(state.current?.winnerId).toBeNull();
    expect(state.current?.nextDrawerId).toBe("player-2");
    expect(state.players.map((candidate) => candidate.score)).toEqual([0, 0]);
  });

  it("ne divulgue le mot qu’au dessinateur avant la révélation", () => {
    const state = startedRoom();
    ready(state, "player-1", 3, deterministic);
    const drawerSession: Session = { id: "drawer-session", token: "token", role: "player", playerId: "player-1", createdAt: 0 };
    const otherSession: Session = { id: "other-session", token: "token", role: "player", playerId: "player-2", createdAt: 0 };
    const projectionSession: Session = { id: "projection-session", token: "token", role: "projection", createdAt: 0 };
    expect(snapshotFor(state, drawerSession, 4).secretWord).toBeTruthy();
    expect(snapshotFor(state, otherSession, 4).secretWord).toBeNull();
    expect(snapshotFor(state, projectionSession, 4).secretWord).toBeNull();
  });

  it("refuse une résolution déjà validée et l’annulation qui la suivrait", () => {
    const state = startedRoom();
    ready(state, "player-1", 3, deterministic);
    appendStroke(state, "player-1", {
      id: "stroke-0003", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);
    selectWinner(state, "player-2", 7);

    expect(() => selectWinner(state, "player-2", 8)).toThrow(GameRuleError);
    expect(() => selectNoWinner(state, 8, deterministic)).toThrow(GameRuleError);
    expect(() => cancelTurn(state, 8)).toThrow(GameRuleError);
    expect(state.players.map((candidate) => candidate.score)).toEqual([1, 1]);
  });

  it("arrête le dessin à l’échéance et permet de rétablir un trait annulé", () => {
    const state = startedRoom();
    ready(state, "player-1", 3, deterministic);
    appendStroke(state, "player-1", {
      id: "stroke-0004", tool: "pen", width: 8, points: [{ x: 0.1, y: 0.1 }], complete: true,
    }, 5);
    undo(state, "player-1", 6);
    expect(state.current?.strokes).toHaveLength(0);
    redo(state, "player-1", 7);
    expect(state.current?.strokes).toHaveLength(1);

    expect(expireTurn(state, 60_004)).toBe(false);
    expect(() => appendStroke(state, "player-1", {
      id: "stroke-0005", tool: "pen", width: 8, points: [{ x: 0.2, y: 0.2 }], complete: true,
    }, 60_005)).toThrow("Le temps est écoulé.");
    expect(state.phase).toBe("revealing");
  });

  it("borne le volume du canevas sur un tour", () => {
    const state = startedRoom();
    ready(state, "player-1", 3, deterministic);
    const points = Array.from({ length: MAX_POINTS_PER_STROKE }, (_, index) => ({ x: index / MAX_POINTS_PER_STROKE, y: 0.5 }));
    for (let index = 0; index < 7; index += 1) {
      appendStroke(state, "player-1", {
        id: `stroke-limit-${index}`, tool: "pen", width: 8, points, complete: true,
      }, 5 + index);
    }
    expect(() => appendStroke(state, "player-1", {
      id: "stroke-limit-overflow", tool: "pen", width: 8, points, complete: true,
    }, 20)).toThrow("La limite de points pour ce tour est atteinte.");
  });
});
