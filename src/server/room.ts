import { DurableObject } from "cloudflare:workers";
import {
  addPlayer,
  appendStroke,
  cancelTurn,
  configure,
  createRoomState,
  endGame,
  expireTurn,
  GameRuleError,
  nextTurn,
  ready,
  redo,
  selectNoWinner,
  selectWinner,
  snapshotFor,
  startGame,
  undo,
  clear,
} from "../domain/game";
import type { Player, RoomState, Session } from "../domain/types";
import { clientCommandSchema, type ClientCommand, type JoinRoomRequest } from "../shared/protocol";

interface SocketAttachment {
  sessionId: string;
}

interface CreateRoomInput {
  code: string;
  controllerToken: string;
}

interface JoinResult {
  token: string;
  playerId?: string;
}

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;

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
      createdAt: now,
    };
    this.state = createRoomState(input.code, controller, now);
    this.persist();
    await this.scheduleNextAlarm();
  }

  async join(input: JoinRoomRequest): Promise<JoinResult> {
    const state = this.requireState();
    const now = Date.now();
    const token = randomId();
    const session: Session = {
      id: randomId(),
      token,
      role: input.role,
      createdAt: now,
    };
    if (input.role === "player") {
      const player: Player = {
        id: randomId(),
        name: input.name.trim(),
        score: 0,
        joinedAt: now,
      };
      addPlayer(state, player, now);
      session.playerId = player.id;
    }
    state.sessions.push(session);
    state.updatedAt = now;
    this.persist();
    await this.scheduleNextAlarm();
    this.broadcast();
    return { token, playerId: session.playerId };
  }

  async issueTicket(token: string): Promise<{ ticket: string }> {
    const state = this.requireState();
    const session = this.getSessionByToken(token);
    const now = Date.now();
    state.tickets = state.tickets.filter((candidate) => candidate.expiresAt > now);
    const ticket = randomId();
    state.tickets.push({ value: ticket, sessionId: session.id, expiresAt: now + TICKET_TTL_MS });
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
    state.tickets = state.tickets.filter((candidate) => candidate.value !== ticket.value);
    state.updatedAt = now;
    this.persist();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sessionId: ticket.sessionId } satisfies SocketAttachment);
    const session = this.getSession(ticket.sessionId);
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
    if (state.phase === "drawing" && state.current?.deadlineAt && state.current.deadlineAt <= now) {
      if (expireTurn(state, now)) {
        this.persist();
        this.broadcast();
        await this.scheduleNextAlarm();
        return;
      }
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
    if (expireTurn(state, now)) {
      this.persist();
      this.broadcast();
      await this.scheduleNextAlarm();
    }
    const requireController = (): void => {
      if (session.role !== "controller") throw new GameRuleError("Réservé au contrôleur de jeu.");
    };
    const requireDrawer = (): string => {
      if (session.role !== "player" || !session.playerId) throw new GameRuleError("Réservé au dessinateur.");
      return session.playerId;
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
      case "start_game":
        requireController();
        startGame(state, now, secureRandom);
        break;
      case "ready":
        requireCurrentTurn(command.turnId);
        ready(state, requireDrawer(), now, secureRandom);
        break;
      case "stroke": {
        requireCurrentTurn(command.turnId);
        const result = appendStroke(state, requireDrawer(), command.stroke, now);
        strokeDelta = result.stroke;
        shouldScheduleAlarm = result.deadlineAt !== null;
        break;
      }
      case "undo":
        requireCurrentTurn(command.turnId);
        undo(state, requireDrawer(), now);
        shouldScheduleAlarm = false;
        break;
      case "redo":
        requireCurrentTurn(command.turnId);
        redo(state, requireDrawer(), now);
        shouldScheduleAlarm = false;
        break;
      case "clear":
        requireCurrentTurn(command.turnId);
        clear(state, requireDrawer(), now);
        shouldScheduleAlarm = false;
        break;
      case "select_winner":
        requireController();
        requireCurrentTurn(command.turnId);
        selectWinner(state, command.playerId, now);
        break;
      case "no_winner":
        requireController();
        requireCurrentTurn(command.turnId);
        selectNoWinner(state, now, secureRandom);
        break;
      case "next_turn":
        requireController();
        requireCurrentTurn(command.turnId);
        nextTurn(state, now);
        break;
      case "cancel_turn":
        requireController();
        requireCurrentTurn(command.turnId);
        cancelTurn(state, now);
        break;
      case "end_game":
        requireController();
        endGame(state, now);
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
    if (state.current) {
      state.current.id ??= `legacy-turn-${state.current.round}`;
      state.current.redoStrokes ??= [];
      if (!Number.isInteger(state.current.pointCount) || state.current.pointCount < 0) {
        state.current.pointCount = state.current.strokes.reduce((total, stroke) => total + stroke.points.length, 0);
      }
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
    const deadline = state.phase === "drawing" ? state.current?.deadlineAt : null;
    const nextAlarm = deadline ?? state.updatedAt + ROOM_TTL_MS;
    if (await this.ctx.storage.getAlarm() !== nextAlarm) await this.ctx.storage.setAlarm(nextAlarm);
  }
}
