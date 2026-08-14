import { z } from "zod";
import { DIFFICULTIES, DURATIONS, ROUND_COUNTS } from "../domain/types";

const pointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
}).strict();

const strokeFields = {
  id: z.string().min(8).max(80),
  tool: z.enum(["pen", "eraser"]),
  width: z.number().min(1).max(48),
  complete: z.boolean(),
};

const strokeChunkSchema = z.object({
  ...strokeFields,
  points: z.array(pointSchema).min(1).max(96),
}).strict();

const persistedStrokeSchema = z.object({
  ...strokeFields,
  points: z.array(pointSchema).min(1).max(1_024),
}).strict();

const uniqueValues = <T extends string>(values: T[]): boolean => new Set(values).size === values.length;

const settingsSchema = z.object({
  durationSeconds: z.union(DURATIONS.map((value) => z.literal(value)) as [z.ZodLiteral<30>, z.ZodLiteral<60>, z.ZodLiteral<90>]),
  rounds: z.union(ROUND_COUNTS.map((value) => z.literal(value)) as [z.ZodLiteral<5>, z.ZodLiteral<10>, z.ZodLiteral<15>]),
  difficulties: z.array(z.enum(DIFFICULTIES)).min(1).max(DIFFICULTIES.length).refine(uniqueValues),
}).strict();

const turnCommand = { turnId: z.string().min(6).max(80) };

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_player"), name: z.string().trim().min(2).max(24) }).strict(),
  z.object({ type: z.literal("remove_player"), playerId: z.string().min(8).max(80) }).strict(),
  z.object({ type: z.literal("start_game"), settings: settingsSchema }).strict(),
  z.object({ type: z.literal("return_to_lobby") }).strict(),
  z.object({ type: z.literal("set_display_mode"), displayMode: z.enum(["drawing", "projection"]) }).strict(),
  z.object({ type: z.literal("take_drawing_turn"), ...turnCommand }).strict(),
  z.object({ type: z.literal("ready"), ...turnCommand }).strict(),
  z.object({ type: z.literal("stroke"), canvasRevision: z.number().int().nonnegative(), stroke: strokeChunkSchema, ...turnCommand }).strict(),
  z.object({ type: z.literal("undo"), ...turnCommand }).strict(),
  z.object({ type: z.literal("redo"), ...turnCommand }).strict(),
  z.object({ type: z.literal("clear"), ...turnCommand }).strict(),
  z.object({ type: z.literal("select_winner"), playerId: z.string().min(8).max(80), ...turnCommand }).strict(),
  z.object({ type: z.literal("no_winner"), ...turnCommand }).strict(),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;

export const createRoomSchema = z.object({}).strict();
export const joinRoomSchema = z.object({ role: z.literal("terminal") }).strict();

export type JoinRoomRequest = z.infer<typeof joinRoomSchema>;

const playerSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(24),
  score: z.number().int().nonnegative(),
  joinedAt: z.number().finite().nonnegative(),
}).strict();

const publicTurnSchema = z.object({
  id: z.string().min(6).max(80),
  round: z.number().int().positive(),
  drawerId: z.string().min(1).max(80),
  drawerName: z.string().min(1).max(24),
  readyDeadlineAt: z.number().finite().nonnegative(),
  armedDeadlineAt: z.number().finite().nonnegative().nullable(),
  deadlineAt: z.number().finite().nonnegative().nullable(),
  revealedWord: z.string().min(1).max(120).nullable(),
  strokes: z.array(persistedStrokeSchema).max(240),
  winnerId: z.string().min(1).max(80).nullable(),
  nextDrawerId: z.string().min(1).max(80).nullable(),
  canvasRevision: z.number().int().nonnegative(),
}).strict();

export const roomSnapshotSchema = z.object({
  code: z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/),
  revision: z.number().int().nonnegative(),
  phase: z.enum(["lobby", "awaiting_ready", "armed", "drawing", "resolving", "revealing", "finished"]),
  settings: settingsSchema,
  players: z.array(playerSchema).max(12),
  turn: publicTurnSchema.nullable(),
  canDraw: z.boolean(),
  canTakeDrawingTurn: z.boolean(),
  canSelectWinner: z.boolean(),
  displayMode: z.enum(["drawing", "projection"]),
  devicePresence: z.object({
    projectors: z.number().int().nonnegative().max(20),
    drawingPhones: z.number().int().nonnegative().max(20),
    hasRequiredDevices: z.boolean(),
  }).strict(),
  secretWord: z.string().min(1).max(120).nullable(),
  finishedWinnerIds: z.array(z.string().min(1).max(80)).max(12),
  serverNow: z.number().finite().nonnegative(),
}).strict();

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: roomSnapshotSchema }).strict(),
  z.object({
    type: z.literal("stroke_delta"),
    revision: z.number().int().nonnegative(),
    turnId: z.string().min(6).max(80),
    canvasRevision: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    stroke: strokeChunkSchema,
  }).strict(),
  z.object({ type: z.literal("error"), message: z.string().min(1).max(240) }).strict(),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
