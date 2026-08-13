import { describe, expect, it } from "vitest";
import type { RoomSnapshot, Stroke } from "../src/domain/types";
import type { ServerMessage } from "../src/shared/protocol";
import { mergeStrokeDelta, parseServerMessage, reduceRoomMessage } from "../src/client/room-state";

const initialStroke: Stroke = {
  id: "stroke-0001",
  tool: "pen",
  width: 8,
  points: [{ x: 0.1, y: 0.1 }],
  complete: false,
};

const snapshot = (revision = 10): RoomSnapshot => ({
  code: "ABC234",
  revision,
  phase: "drawing",
  settings: { durationSeconds: 60, rounds: 5, difficulties: ["facile"] },
  players: [{ id: "player-0001", name: "Lila", score: 0, joinedAt: 0 }],
  turn: {
    id: "turn-1",
    round: 1,
    drawerId: "player-0001",
    drawerName: "Lila",
    readyDeadlineAt: 30_000,
    armedDeadlineAt: null,
    deadlineAt: 60_000,
    revealedWord: null,
    strokes: [initialStroke],
    winnerId: null,
    nextDrawerId: null,
    canvasRevision: 0,
  },
  canDraw: false,
  canTakeDrawingTurn: false,
  canSelectWinner: false,
  displayMode: "projection",
  secretWord: null,
  finishedWinnerIds: [],
  serverNow: 1_000,
});

const delta = (overrides: Partial<Extract<ServerMessage, { type: "stroke_delta" }>> = {}): Extract<ServerMessage, { type: "stroke_delta" }> => ({
  type: "stroke_delta",
  revision: 11,
  turnId: "turn-1",
  canvasRevision: 0,
  offset: 1,
  stroke: {
    id: "stroke-0001",
    tool: "pen",
    width: 8,
    points: [{ x: 0.2, y: 0.2 }],
    complete: true,
  },
  ...overrides,
});

describe("réduction de l’état temps réel", () => {
  it("ignore un snapshot plus ancien", () => {
    const current = snapshot(10);
    const older = snapshot(9);
    expect(reduceRoomMessage(current, { type: "snapshot", snapshot: older }).snapshot).toBe(current);
  });

  it("ajoute un delta exactement à son offset et ignore son duplicata", () => {
    const merged = mergeStrokeDelta(snapshot(), delta()).snapshot;
    expect(merged?.revision).toBe(11);
    expect(merged?.turn?.strokes[0]?.points).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]);
    expect(mergeStrokeDelta(merged, delta()).snapshot).toBe(merged);
  });

  it("demande une resynchronisation lorsqu’un fragment manque", () => {
    expect(mergeStrokeDelta(snapshot(), delta({ offset: 3 })).needsResync).toBe(true);
  });

  it("resynchronise un delta plus récent provenant d’un autre tour", () => {
    const current = snapshot();
    const result = mergeStrokeDelta(current, delta({ turnId: "turn-previous" }));
    expect(result).toEqual({ snapshot: current, needsResync: true });
  });

  it("rejette les messages dont la structure imbriquée est invalide", () => {
    expect(parseServerMessage({ type: "snapshot", snapshot: { code: "ABC234", revision: 1, phase: "drawing", players: [] } })).toBeNull();
    expect(parseServerMessage({ ...delta(), stroke: { id: "stroke-0001" } })).toBeNull();
  });

  it("accepte l’état de résolution après le chrono", () => {
    const resolving = snapshot(12);
    resolving.phase = "resolving";
    resolving.canSelectWinner = true;
    resolving.turn!.deadlineAt = 1_000;
    expect(parseServerMessage({ type: "snapshot", snapshot: resolving })).not.toBeNull();
  });

  it("accepte dans un snapshot un trait complet plus long qu’un fragment réseau", () => {
    const longStroke = { ...initialStroke, points: Array.from({ length: 1_024 }, (_, index) => ({ x: index / 1_024, y: 0.5 })) };
    const current = snapshot();
    current.turn!.strokes = [longStroke];
    expect(parseServerMessage({ type: "snapshot", snapshot: current })).not.toBeNull();
    expect(parseServerMessage({ ...delta(), stroke: longStroke })).toBeNull();
  });
});
