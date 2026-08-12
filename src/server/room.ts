import { DurableObject } from "cloudflare:workers";
import {
  addPlayer,
  appendStroke,
  configure,
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
  selectWinner,
  setTerminalDisplayMode,
  snapshotFor,
  startGame,
  takeDrawingTurn,
  undo,
  clear,
} from "../domain/game";
import type { Role, RoomState, Session } from "../domain/types";
import { clientCommandSchema, type ClientCommand, type JoinRoomRequest } from "../shared/protocol";

interface SocketAttachment {
  sessionId: string;
}

interface CreateRoomInput {
  code: string;
  controllerToken: string;
}

type JoinResult = { token: string } | { error: string };

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;
const TERMINAL_SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_TERMINAL_SESSIONS = 16;
const MAX_ROOM_SOCKETS = 20;

const asErrorMessage = (error: unknown): string => error instanceof GameRuleError
  ? error.message
  : "Une erreur de jeu est survenue.";

const randomId = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const secureRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000;

export class GameRoom extends DurableObject {
  private state: RoomState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload TEXT NOT NULL
        )
      `);
      this.state = this.readState();
    });
  }

  async create(input: CreateRoomInput): Promise<void> {
    if (this.getState()) throw new GameRuleError("Ce code de salle existe déjà.");
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
    this.persist();
    await this.scheduleNextAlarm();
  }

  async join(input: JoinRoomRequest): Promise<JoinResult> {
    const state = this.requireState();
    const now = Date.now();
    const pruned = this.pruneInactiveTerminalSessions(state, now);
    if (state.sessions.filter((session) => session.role === "terminal").length >= MAX_TERMINAL_SESSIONS) {
      if (pruned) {
        state.updatedAt = now;
        this.persist();
        await this.scheduleNextAlarm();
      }
      return { error: "La limite de téléphones terminaux est atteinte." };
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
    if (this.ctx.getWebSockets().length >= MAX_ROOM_SOCKETS) {
      return new Response("Room connection limit reached", { status: 429 });
    }
    state.tickets = state.tickets.filter((candidate) => candidate.value !== ticket.value);
    state.updatedAt = now;
    const session = this.getSession(ticket.sessionId);
    session.lastSeenAt = now;
    this.persist();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sessionId: ticket.sessionId } satisfies SocketAttachment);
    this.sendSnapshot(server, session);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 24_000) {
      this.sendError(ws, "Commande invalide.");
      return;
    }
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      ws.close(1008, "Session missing");
      return;
    }
    const session = this.getSession(attachment.sessionId);
    try {
      const command = clientCommandSchema.parse(JSON.parse(message));
      const stroke = await this.applyCommand(session, command);
      if (stroke) this.broadcastStroke(stroke);
      else this.broadcast();
    } catch (error) {
      this.sendError(ws, asErrorMessage(error));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close(1000, "Closed");
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "WebSocket error");
  }

  async alarm(): Promise<void> {
    const state = this.getState();
    if (!state) return;
    const now = Date.now();
    if (expireReadyDrawer(state, now, secureRandom) || expireArmedTurn(state, now, secureRandom) || expireTurn(state, now, secureRandom)) {
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
    if (state.updatedAt + ROOM_TTL_MS <= now) {
      this.ctx.storage.sql.exec("DELETE FROM room_state WHERE id = 1");
      this.state = null;
      for (const ws of this.ctx.getWebSockets()) ws.close(1001, "Room expired");
      return;
    }
    await this.ctx.storage.setAlarm(state.updatedAt + ROOM_TTL_MS);
  }

  private async applyCommand(session: Session, command: ClientCommand): Promise<import("../domain/types").Stroke | null> {
    const state = this.requireState();
    const now = Date.now();
    if (expireReadyDrawer(state, now, secureRandom) || expireArmedTurn(state, now, secureRandom) || expireTurn(state, now, secureRandom)) {
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

    let strokeDelta: import("../domain/types").Stroke | null = null;
    let shouldScheduleAlarm = true;
    switch (command.type) {
      case "configure":
        requireController();
        configure(state, command.settings, now);
        break;
      case "add_player":
        requireController();
        addPlayer(state, { id: randomId(), name: command.name.trim(), score: 0, joinedAt: now }, now);
        break;
      case "start_game":
        requireController();
        startGame(state, now, secureRandom);
        break;
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
        const result = appendStroke(state, requireTerminal(), command.stroke, now);
        // The first trait changes phase and starts the deadline. A snapshot is
        // required so every device receives those authoritative fields.
        if (result.deadlineAt === null) strokeDelta = result.stroke;
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
    this.persist();
    if (shouldScheduleAlarm) await this.scheduleNextAlarm();
    return strokeDelta;
  }

  private broadcast(): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) continue;
      const session = this.requireState().sessions.find((candidate) => candidate.id === attachment.sessionId);
      if (session) this.sendSnapshot(ws, session);
    }
  }

  private sendSnapshot(ws: WebSocket, session: Session): void {
    ws.send(JSON.stringify({ type: "snapshot", snapshot: snapshotFor(this.requireState(), session, Date.now()) }));
  }

  private broadcastStroke(stroke: import("../domain/types").Stroke): void {
    const round = this.requireState().current?.round;
    if (!round) return;
    const message = JSON.stringify({ type: "stroke_delta", round, stroke });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    ws.send(JSON.stringify({ type: "error", message }));
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
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
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
    if (!this.state) this.state = this.readState();
    return this.state;
  }

  private requireState(): RoomState {
    const state = this.getState();
    if (!state) throw new GameRuleError("Cette salle n’existe plus.");
    return state;
  }

  private readState(): RoomState | null {
    const row = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM room_state WHERE id = 1").toArray()[0];
    if (!row) return null;
    const state = JSON.parse(row.payload) as RoomState;
    state.turnSequence ??= state.current?.round ?? 0;
    const persistedSessions = state.sessions as Array<Omit<Session, "role"> & { role: Role | "player"; playerId?: string }>;
    for (const legacySession of persistedSessions) {
      if (legacySession.role === "player") legacySession.role = "terminal";
      delete legacySession.playerId;
      legacySession.lastSeenAt ??= legacySession.createdAt;
      legacySession.displayMode ??= legacySession.role === "terminal" ? "drawing" : "projection";
    }
    if (state.current) {
      state.current.id ??= `legacy-turn-${state.current.round}`;
      state.current.redoStrokes ??= [];
      state.current.drawerTerminalSessionId ??= null;
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

  private persist(): void {
    const state = this.requireState();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO room_state (id, payload) VALUES (1, ?)",
      JSON.stringify(state),
    );
  }

  private async scheduleNextAlarm(): Promise<void> {
    const state = this.requireState();
    const readyDeadline = state.phase === "awaiting_ready" ? state.current?.readyDeadlineAt : null;
    const armedDeadline = state.phase === "armed" ? state.current?.armedDeadlineAt : null;
    const drawingDeadline = state.phase === "drawing" ? state.current?.deadlineAt : null;
    const revealedAt = state.phase === "revealing" ? state.current?.revealedAt ?? null : null;
    const deadline = readyDeadline ?? armedDeadline ?? drawingDeadline ?? (revealedAt === null ? null : revealedAt + REVEAL_DURATION_MS);
    const nextAlarm = deadline ?? state.updatedAt + ROOM_TTL_MS;
    if (await this.ctx.storage.getAlarm() !== nextAlarm) await this.ctx.storage.setAlarm(nextAlarm);
  }
}
