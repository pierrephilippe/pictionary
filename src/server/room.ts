import { DurableObject } from "cloudflare:workers";
import { ZodError } from "zod";
import {
  addPlayer,
  appendStroke,
  createRoomState,
  expireArmedTurn,
  expireReadyDrawer,
  expireTurn,
  GameRuleError,
  nextTurn,
  noWinner,
  READY_DURATION_MS,
  REVEAL_DURATION_MS,
  ready,
  redo,
  removePlayer,
  returnToLobby,
  selectWinner,
  setTerminalDisplayMode,
  snapshotFor,
  startGame,
  takeDrawingTurn,
  undo,
  clear,
} from "../domain/game";
import { DEFAULT_SETTINGS, type DevicePresence, type Role, type RoomState, type Session } from "../domain/types";
import { clientCommandSchema, type ClientCommand, type JoinRoomRequest, type ServerMessage } from "../shared/protocol";

interface SocketAttachment {
  sessionId: string;
}

interface CreateRoomInput {
  code: string;
  controllerToken: string;
}

type JoinResult = { token: string } | { error: string; status: 404 | 429 };
type StrokeDeltaMessage = Extract<ServerMessage, { type: "stroke_delta" }>;

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;
const TERMINAL_SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_TERMINAL_SESSIONS = 16;
const MAX_ROOM_SOCKETS = 20;
const COMMAND_WINDOW_MS = 1_000;
const MAX_COMMANDS_PER_WINDOW = 40;

class CommandRateLimitError extends GameRuleError {}

const asErrorMessage = (error: unknown): string => error instanceof GameRuleError
  ? error.message
  : error instanceof ZodError
    ? "Commande invalide."
  : "Une erreur de jeu est survenue.";

const randomId = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const secureRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000;

export class GameRoom extends DurableObject<Env> {
  private state: RoomState | null = null;
  private loaded = false;
  // The hibernation API may deliver another socket event while a command is
  // awaiting alarm persistence. Keep state mutation and its broadcast in the
  // same order as the client frames so an old stroke can never follow `clear`.
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = this.readState();
      this.loaded = true;
    });
  }

  async create(input: CreateRoomInput): Promise<void> {
    if (this.getState()) throw new GameRuleError("Ce code de salle existe déjà.");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL
      )
    `);
    const now = Date.now();
    const controller: Session = {
      id: randomId(),
      token: input.controllerToken,
      role: "controller",
      displayMode: "projection",
      createdAt: now,
      lastSeenAt: now,
    };
    this.state = createRoomState(input.code, controller, now);
    this.loaded = true;
    this.persist();
    await this.scheduleNextAlarm();
  }

  async join(input: JoinRoomRequest): Promise<JoinResult> {
    const state = this.getState();
    if (!state) return { error: "Cette salle n’existe plus.", status: 404 };
    const now = Date.now();
    const pruned = this.pruneInactiveTerminalSessions(state, now);
    if (state.sessions.filter((session) => session.role === "terminal").length >= MAX_TERMINAL_SESSIONS) {
      if (pruned) {
        state.updatedAt = now;
        this.persist();
        await this.scheduleNextAlarm();
      }
      return { error: "La limite de téléphones terminaux est atteinte.", status: 429 };
    }
    const token = randomId();
    const session: Session = {
      id: randomId(),
      token,
      role: input.role,
      displayMode: "drawing",
      createdAt: now,
      lastSeenAt: now,
    };
    state.sessions.push(session);
    state.updatedAt = now;
    state.lastActivityAt = now;
    this.persist();
    await this.scheduleNextAlarm();
    return { token };
  }

  async issueTicket(token: string): Promise<{ ticket: string }> {
    const state = this.requireState();
    const session = this.getSessionByToken(token);
    const now = Date.now();
    state.tickets = state.tickets.filter((candidate) => candidate.expiresAt > now && candidate.sessionId !== session.id);
    const ticket = randomId();
    state.tickets.push({ value: ticket, sessionId: session.id, expiresAt: now + TICKET_TTL_MS });
    session.lastSeenAt = now;
    state.updatedAt = now;
    this.persist();
    await this.scheduleNextAlarm();
    return { ticket };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/socket") return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket required", { status: 426 });

    const state = this.requireState();
    const now = Date.now();
    const ticketValue = url.searchParams.get("ticket");
    const ticket = state.tickets.find((candidate) => candidate.value === ticketValue && candidate.expiresAt > now);
    if (!ticket) return new Response("Invalid connection ticket", { status: 401 });
    const session = this.getSession(ticket.sessionId);
    const existingSockets = this.ctx.getWebSockets();
    const otherActiveSockets = existingSockets.filter((candidate) => {
      const attachment = this.socketAttachment(candidate);
      return attachment?.sessionId !== session.id && candidate.readyState === WebSocket.OPEN;
    });
    if (otherActiveSockets.length >= MAX_ROOM_SOCKETS) {
      return new Response("Room connection limit reached", { status: 429 });
    }
    for (const existing of existingSockets) {
      if (this.socketAttachment(existing)?.sessionId === session.id) this.safeClose(existing, 1000, "Session replaced");
    }
    state.tickets = state.tickets.filter((candidate) => candidate.value !== ticket.value);
    state.updatedAt = now;
    session.lastSeenAt = now;
    this.persist();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sessionId: ticket.sessionId } satisfies SocketAttachment);
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const handleMessage = async (): Promise<void> => {
      if (typeof message !== "string" || message.length > 24_000 || new TextEncoder().encode(message).byteLength > 24_000) {
        this.safeClose(ws, 1009, "Message too large");
        return;
      }
      const attachment = this.socketAttachment(ws);
      if (!attachment) {
        this.safeClose(ws, 1008, "Session missing");
        return;
      }
      // A deletion can close several sockets while already queued frames are
      // still delivered. They no longer belong to a room and must be ignored.
      if (!this.getState()) return;
      const session = this.getSession(attachment.sessionId);
      try {
        // Count every accepted socket frame, including malformed and refused
        // commands. Persisting the counter in the error path keeps the limit
        // effective when a hibernating Durable Object is revived.
        this.enforceCommandRate(session, Date.now());
        const command = clientCommandSchema.parse(JSON.parse(message));
        const strokeDelta = await this.applyCommand(session, command);
        if (strokeDelta) this.broadcastStroke(strokeDelta);
        else this.broadcast();
      } catch (error) {
        if (error instanceof CommandRateLimitError) {
          this.safeClose(ws, 1008, "Command rate exceeded");
          return;
        }
        // `enforceCommandRate` mutates the session before a command can be
        // rejected. Persist it so invalid-message floods cannot reset their
        // allowance by relying on Durable Object hibernation.
        this.persist();
        this.sendError(ws, asErrorMessage(error));
      }
    };
    // Do not use blockConcurrencyWhile here: it is intended for startup only
    // and would unnecessarily stall the whole room. This small in-memory queue
    // is rebuilt after hibernation, when no command is in progress.
    this.commandQueue = this.commandQueue.catch(() => undefined).then(handleMessage);
    return this.commandQueue;
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.safeClose(ws, 1000, "Closed");
    this.broadcast();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.safeClose(ws, 1011, "WebSocket error");
    this.broadcast();
  }

  async alarm(): Promise<void> {
    const state = this.getState();
    if (!state) return;
    const now = Date.now();
    if (state.lastActivityAt + ROOM_TTL_MS <= now) {
      this.ctx.storage.sql.exec("DELETE FROM room_state WHERE id = 1");
      this.state = null;
      for (const ws of this.ctx.getWebSockets()) this.safeClose(ws, 1001, "Room expired");
      return;
    }
    if (expireReadyDrawer(state, now, secureRandom) || expireArmedTurn(state, now, secureRandom) || expireTurn(state, now)) {
      this.persist();
      this.broadcast();
      await this.scheduleNextAlarm();
      return;
    }
    const revealedAt = state.phase === "revealing" ? state.current?.revealedAt ?? null : null;
    const revealDeadline = revealedAt === null ? null : revealedAt + REVEAL_DURATION_MS;
    if (revealDeadline !== null && revealDeadline <= now) {
      nextTurn(state, now);
      this.persist();
      this.broadcast();
      await this.scheduleNextAlarm();
      return;
    }
    await this.scheduleNextAlarm();
  }

  private async applyCommand(session: Session, command: ClientCommand): Promise<StrokeDeltaMessage | null> {
    const state = this.requireState();
    const now = Date.now();
    if (expireReadyDrawer(state, now, secureRandom) || expireArmedTurn(state, now, secureRandom) || expireTurn(state, now)) {
      this.persist();
      this.broadcast();
      await this.scheduleNextAlarm();
    }
    const requireController = (): void => {
      if (session.role !== "controller") throw new GameRuleError("Réservé au contrôleur de jeu.");
    };
    const requireTerminal = (): string => {
      if (session.role !== "terminal") throw new GameRuleError("Réservé à un téléphone de dessin.");
      if (session.displayMode === "projection") throw new GameRuleError("Ce téléphone est en mode projecteur.");
      return session.id;
    };
    const requireCurrentTurn = (turnId: string): void => {
      if (!state.current || state.current.id !== turnId) throw new GameRuleError("Cette commande concerne un tour déjà terminé.");
    };

    let strokeResult: { offset: number; stroke: import("../domain/types").Stroke } | null = null;
    let shouldScheduleAlarm = true;
    switch (command.type) {
      case "add_player":
        requireController();
        addPlayer(state, { id: randomId(), name: command.name.trim(), score: 0, joinedAt: now }, now);
        break;
      case "remove_player":
        requireController();
        removePlayer(state, command.playerId, now);
        break;
      case "start_game":
        requireController();
        this.assertRequiredDevices();
        startGame(state, command.settings, now, secureRandom);
        break;
      case "return_to_lobby":
        requireController();
        returnToLobby(state, now);
        break;
      case "delete_room":
        requireController();
        await this.deleteRoom();
        return null;
      case "set_display_mode":
        setTerminalDisplayMode(state, session, command.displayMode, now);
        break;
      case "take_drawing_turn":
        requireCurrentTurn(command.turnId);
        takeDrawingTurn(state, requireTerminal(), now);
        break;
      case "ready":
        requireCurrentTurn(command.turnId);
        ready(state, requireTerminal(), now, secureRandom);
        break;
      case "stroke": {
        requireCurrentTurn(command.turnId);
        const result = appendStroke(state, requireTerminal(), command.canvasRevision, command.stroke, now);
        // The first trait changes phase and starts the deadline. A snapshot is
        // required so every device receives those authoritative fields.
        if (result.deadlineAt === null) strokeResult = { offset: result.offset, stroke: result.stroke };
        shouldScheduleAlarm = result.deadlineAt !== null;
        break;
      }
      case "undo":
        requireCurrentTurn(command.turnId);
        undo(state, requireTerminal(), now);
        shouldScheduleAlarm = false;
        break;
      case "redo":
        requireCurrentTurn(command.turnId);
        redo(state, requireTerminal(), now);
        shouldScheduleAlarm = false;
        break;
      case "clear":
        requireCurrentTurn(command.turnId);
        clear(state, requireTerminal(), now);
        shouldScheduleAlarm = false;
        break;
      case "select_winner":
        requireCurrentTurn(command.turnId);
        selectWinner(state, requireTerminal(), command.playerId, now);
        break;
      case "no_winner":
        requireCurrentTurn(command.turnId);
        noWinner(state, requireTerminal(), now, secureRandom);
        break;
      default:
        command satisfies never;
    }
    state.lastActivityAt = now;
    const revision = this.persist();
    if (shouldScheduleAlarm) await this.scheduleNextAlarm();
    return strokeResult && state.current ? {
      type: "stroke_delta",
      revision,
      turnId: state.current.id,
      canvasRevision: state.current.canvasRevision,
      offset: strokeResult.offset,
      stroke: strokeResult.stroke,
    } : null;
  }

  private broadcast(): void {
    const state = this.getState();
    if (!state) return;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const attachment = this.socketAttachment(ws);
      if (!attachment) continue;
      const session = state.sessions.find((candidate) => candidate.id === attachment.sessionId);
      if (session) this.sendSnapshot(ws, session);
    }
  }

  private async deleteRoom(): Promise<void> {
    // Remove the durable source of truth before closing sockets: close events
    // and any already queued frames then cannot revive or persist the room.
    this.ctx.storage.sql.exec("DELETE FROM room_state WHERE id = 1");
    this.state = null;
    await this.ctx.storage.deleteAlarm();
    for (const ws of this.ctx.getWebSockets()) this.safeClose(ws, 4004, "Room deleted");
  }

  private sendSnapshot(ws: WebSocket, session: Session): void {
    this.safeSend(ws, {
      type: "snapshot",
      snapshot: snapshotFor(this.requireState(), session, Date.now(), this.devicePresence()),
    });
  }

  private broadcastStroke(message: StrokeDeltaMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) this.safeSend(ws, message);
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    this.safeSend(ws, { type: "error", message });
  }

  private safeSend(ws: WebSocket, message: ServerMessage): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      this.safeClose(ws, 1011, "Delivery failed");
      return false;
    }
  }

  private safeClose(ws: WebSocket, code: number, reason: string): void {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
    } catch {
      // A socket may transition between the readyState check and close().
    }
  }

  private socketAttachment(ws: WebSocket): SocketAttachment | null {
    const attachment: unknown = ws.deserializeAttachment();
    if (!attachment || typeof attachment !== "object" || !("sessionId" in attachment) || typeof attachment.sessionId !== "string") {
      return null;
    }
    return { sessionId: attachment.sessionId };
  }

  private devicePresence(): DevicePresence {
    const state = this.requireState();
    const activeSessionIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const attachment = this.socketAttachment(ws);
      if (attachment) activeSessionIds.add(attachment.sessionId);
    }

    let projectors = 0;
    let drawingPhones = 0;
    for (const sessionId of activeSessionIds) {
      const session = state.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) continue;
      if (session.role === "controller" || session.displayMode === "projection") projectors += 1;
      else if (session.role === "terminal") drawingPhones += 1;
    }
    return {
      projectors,
      drawingPhones,
      hasRequiredDevices: projectors > 0 && drawingPhones > 0,
    };
  }

  private assertRequiredDevices(): void {
    const presence = this.devicePresence();
    if (presence.projectors < 1) throw new GameRuleError("Connectez un téléphone projecteur.");
    if (presence.drawingPhones < 1) throw new GameRuleError("Connectez un autre téléphone en mode dessin.");
  }

  private getSessionByToken(token: string): Session {
    const session = this.requireState().sessions.find((candidate) => candidate.token === token);
    if (!session) throw new GameRuleError("Session invalide.");
    return session;
  }

  private getSession(id: string): Session {
    const session = this.requireState().sessions.find((candidate) => candidate.id === id);
    if (!session) throw new GameRuleError("Session introuvable.");
    return session;
  }

  private pruneInactiveTerminalSessions(state: RoomState, now: number): boolean {
    const activeSessionIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(ws);
      if (attachment) activeSessionIds.add(attachment.sessionId);
    }
    const previousCount = state.sessions.length;
    state.sessions = state.sessions.filter((session) => session.role !== "terminal"
      || activeSessionIds.has(session.id)
      || session.lastSeenAt + TERMINAL_SESSION_IDLE_MS > now);
    if (state.sessions.length === previousCount) return false;
    const sessionIds = new Set(state.sessions.map((session) => session.id));
    state.tickets = state.tickets.filter((ticket) => sessionIds.has(ticket.sessionId));
    return true;
  }

  private getState(): RoomState | null {
    if (!this.loaded) {
      this.state = this.readState();
      this.loaded = true;
    }
    return this.state;
  }

  private requireState(): RoomState {
    const state = this.getState();
    if (!state) throw new GameRuleError("Cette salle n’existe plus.");
    return state;
  }

  private readState(): RoomState | null {
    const table = this.ctx.storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_state'",
    ).toArray()[0];
    if (!table) return null;
    const row = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM room_state WHERE id = 1").toArray()[0];
    if (!row) return null;
    const state = JSON.parse(row.payload) as RoomState & {
      version: 1 | 2;
      settings: RoomState["settings"] & { themes?: unknown };
      lastActivityAt?: number;
      revision?: number;
    };
    state.version = 2;
    state.settings = {
      durationSeconds: state.settings?.durationSeconds ?? DEFAULT_SETTINGS.durationSeconds,
      rounds: state.settings?.rounds ?? DEFAULT_SETTINGS.rounds,
      difficulties: state.settings?.difficulties ?? structuredClone(DEFAULT_SETTINGS.difficulties),
    };
    state.lastActivityAt = Number.isFinite(state.lastActivityAt) ? state.lastActivityAt : state.updatedAt ?? state.createdAt;
    state.revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
    state.turnSequence ??= state.current?.round ?? 0;
    const persistedSessions = state.sessions as Array<Omit<Session, "role"> & { role: Role | "player"; playerId?: string }>;
    for (const legacySession of persistedSessions) {
      if (legacySession.role === "player") legacySession.role = "terminal";
      delete legacySession.playerId;
      legacySession.lastSeenAt ??= legacySession.createdAt;
      legacySession.displayMode ??= legacySession.role === "terminal" ? "drawing" : "projection";
      legacySession.commandWindowStartedAt ??= legacySession.lastSeenAt;
      legacySession.commandCount ??= 0;
    }
    if (state.current) {
      state.current.id ??= `legacy-turn-${state.current.round}`;
      state.current.redoStrokes ??= [];
      state.current.drawerTerminalSessionId ??= null;
      state.current.canvasRevision ??= 0;
      state.current.readyDeadlineAt ??= state.updatedAt + READY_DURATION_MS;
      const current = state.current as typeof state.current & { armedDeadlineAt?: number | null };
      current.armedDeadlineAt ??= state.phase === "armed" ? state.updatedAt + READY_DURATION_MS : null;
      if (!Number.isInteger(state.current.pointCount) || state.current.pointCount < 0) {
        state.current.pointCount = state.current.strokes.reduce((total, stroke) => total + stroke.points.length, 0);
      }
      delete (state.current as typeof state.current & { resolutionPending?: boolean }).resolutionPending;
    }
    return state;
  }

  private persist(): number {
    const state = this.requireState();
    const revision = state.revision + 1;
    const payload = JSON.stringify({ ...state, revision });
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO room_state (id, payload) VALUES (1, ?)",
      payload,
    );
    state.revision = revision;
    return revision;
  }

  private enforceCommandRate(session: Session, now: number): void {
    const windowStartedAt = session.commandWindowStartedAt ?? now;
    if (now - windowStartedAt >= COMMAND_WINDOW_MS) {
      session.commandWindowStartedAt = now;
      session.commandCount = 1;
    } else {
      const commandCount = session.commandCount ?? 0;
      if (commandCount >= MAX_COMMANDS_PER_WINDOW) {
        throw new CommandRateLimitError("Trop de commandes envoyées : réessayez dans un instant.");
      }
      session.commandWindowStartedAt = windowStartedAt;
      session.commandCount = commandCount + 1;
    }
    session.lastSeenAt = now;
  }

  private async scheduleNextAlarm(): Promise<void> {
    const state = this.requireState();
    const readyDeadline = state.phase === "awaiting_ready" ? state.current?.readyDeadlineAt : null;
    const armedDeadline = state.phase === "armed" ? state.current?.armedDeadlineAt : null;
    const drawingDeadline = state.phase === "drawing" ? state.current?.deadlineAt : null;
    const revealedAt = state.phase === "revealing" ? state.current?.revealedAt ?? null : null;
    const phaseDeadline = readyDeadline ?? armedDeadline ?? drawingDeadline ?? (revealedAt === null ? null : revealedAt + REVEAL_DURATION_MS);
    const expirationDeadline = state.lastActivityAt + ROOM_TTL_MS;
    const nextAlarm = phaseDeadline === null ? expirationDeadline : Math.min(phaseDeadline, expirationDeadline);
    if (await this.ctx.storage.getAlarm() !== nextAlarm) await this.ctx.storage.setAlarm(nextAlarm);
  }
}
