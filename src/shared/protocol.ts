import { z } from "zod";
import { DIFFICULTIES, DURATIONS, ROUND_COUNTS, THEMES } from "../domain/types";

const pointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const strokeSchema = z.object({
  id: z.string().min(8).max(80),
  tool: z.enum(["pen", "eraser"]),
  width: z.number().min(1).max(48),
  points: z.array(pointSchema).min(1).max(96),
  complete: z.boolean(),
});

const settingsSchema = z.object({
  durationSeconds: z.union(DURATIONS.map((value) => z.literal(value)) as [z.ZodLiteral<30>, z.ZodLiteral<60>, z.ZodLiteral<90>]),
  rounds: z.union(ROUND_COUNTS.map((value) => z.literal(value)) as [z.ZodLiteral<5>, z.ZodLiteral<10>, z.ZodLiteral<15>]),
  themes: z.array(z.enum(THEMES)).min(1),
  difficulties: z.array(z.enum(DIFFICULTIES)).min(1),
});

const turnCommand = z.object({ turnId: z.string().min(6).max(80) });

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("configure"), settings: settingsSchema }),
  z.object({ type: z.literal("add_player"), name: z.string().trim().min(2).max(24) }),
  z.object({ type: z.literal("start_game") }),
  z.object({ type: z.literal("take_drawing_turn") }).merge(turnCommand),
  z.object({ type: z.literal("ready") }).merge(turnCommand),
  z.object({ type: z.literal("stroke"), stroke: strokeSchema }).merge(turnCommand),
  z.object({ type: z.literal("undo") }).merge(turnCommand),
  z.object({ type: z.literal("redo") }).merge(turnCommand),
  z.object({ type: z.literal("clear") }).merge(turnCommand),
  z.object({ type: z.literal("select_winner"), playerId: z.string().min(8).max(80) }).merge(turnCommand),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;

export const createRoomSchema = z.object({}).passthrough();
export const joinRoomSchema = z.object({ role: z.literal("terminal") });

export type JoinRoomRequest = z.infer<typeof joinRoomSchema>;
