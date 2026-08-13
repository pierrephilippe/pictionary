import type { RoomSnapshot, Stroke } from "../domain/types";
import { serverMessageSchema, type ServerMessage } from "../shared/protocol";

export interface RoomMessageResult {
  snapshot: RoomSnapshot | null;
  needsResync: boolean;
}

export const parseServerMessage = (value: unknown): ServerMessage | null => {
  const parsed = serverMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const samePoint = (left: Stroke["points"][number], right: Stroke["points"][number]): boolean =>
  left.x === right.x && left.y === right.y;

export const mergeStrokeDelta = (
  snapshot: RoomSnapshot | null,
  message: Extract<ServerMessage, { type: "stroke_delta" }>,
): RoomMessageResult => {
  if (!snapshot || message.revision <= snapshot.revision) return { snapshot, needsResync: false };
  const turn = snapshot.turn;
  if (!turn || turn.id !== message.turnId || turn.canvasRevision !== message.canvasRevision) {
    return { snapshot, needsResync: true };
  }

  const currentStrokes = turn.strokes;
  const strokeIndex = currentStrokes.findIndex((candidate) => candidate.id === message.stroke.id);
  const current = strokeIndex >= 0 ? currentStrokes[strokeIndex]! : null;
  if ((!current && message.offset !== 0)
    || (current && (current.tool !== message.stroke.tool || current.width !== message.stroke.width))) {
    return { snapshot, needsResync: true };
  }

  const currentLength = current?.points.length ?? 0;
  if (message.offset < currentLength) {
    const overlap = current?.points.slice(message.offset, message.offset + message.stroke.points.length) ?? [];
    const isDuplicate = overlap.length === message.stroke.points.length
      && overlap.every((point, index) => samePoint(point, message.stroke.points[index]!));
    return { snapshot, needsResync: !isDuplicate };
  }
  if (message.offset > currentLength || current?.complete) return { snapshot, needsResync: true };

  const nextStroke: Stroke = current
    ? {
      ...current,
      points: [...current.points, ...message.stroke.points],
      complete: current.complete || message.stroke.complete,
    }
    : { ...message.stroke, points: [...message.stroke.points] };
  const strokes = current
    ? currentStrokes.map((stroke, index) => index === strokeIndex ? nextStroke : stroke)
    : [...currentStrokes, nextStroke];
  return {
    snapshot: {
      ...snapshot,
      revision: message.revision,
      turn: { ...turn, strokes },
    },
    needsResync: false,
  };
};

export const reduceRoomMessage = (
  snapshot: RoomSnapshot | null,
  message: Exclude<ServerMessage, { type: "error" }>,
): RoomMessageResult => {
  if (message.type === "stroke_delta") return mergeStrokeDelta(snapshot, message);
  if (snapshot && message.snapshot.revision < snapshot.revision) return { snapshot, needsResync: false };
  return { snapshot: message.snapshot, needsResync: false };
};
