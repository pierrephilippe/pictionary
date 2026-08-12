import { describe, expect, it } from "vitest";
import {
  addPlayer,
  appendStroke,
  createRoomState,
  expireTurn,
  nextTurn,
  ready,
  selectNoWinner,
  selectWinner,
  snapshotFor,
  startGame,
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

    const deadline = appendStroke(state, "player-1", {
      id: "stroke-0001",
      tool: "pen",
      width: 8,
      points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }],
      complete: true,
    }, 5);
    expect(deadline).toBe(60_005);
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
});
