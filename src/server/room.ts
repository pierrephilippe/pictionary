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
  selectNoWinner,
  selectWinner,
  snapshotFor,
  startGame,
  undo,
  clear,
} from "../domain/game";
import type { Player, RoomState, Session } from "../domain/types";
import { clientCommandSchema, type ClientCommand, type JoinRoomRequest } from "../shared/protocol";
import type { Env } from "./worker";

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
      await this.applyCommand(session, command);
      this.broadcast();
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
      expireTurn(state, now);
      this.persist();
      this.broadcast();
      await this.scheduleNextAlarm();
      return;
    }
    if (state.updatedAt + ROOM_TTL_MS <= now) {
      this.ctx.storage.sql.exec("DELETE FROM room_state WHERE id = 1");
      this.state = null;
      return;
    }
    await this.ctx.storage.setAlarm(state.updatedAt + ROOM_TTL_MS);
  }

  private async applyCommand(session: Session, command: ClientCommand): Promise<void> {
    const state = this.requireState();
    const now = Date.now();
    const requireController = (): void => {
      if (session.role !== "controller") throw new GameRuleError("Réservé au contrôleur de jeu.");
    };
    const requireDrawer = (): string => {
      if (session.role !== "player" || !session.playerId) throw new GameRuleError("Réservé au dessinateur.");
      return session.playerId;
    };

    switch (command.type) {
      case "configure":
        requireController();
        configure(state, command.settings, now);
        break;
      case "start_game":
        requireController();
        startGame(state, now, Math.random);
        break;
      case "ready":
        ready(state, requireDrawer(), now, Math.random);
        break;
      case "stroke": {
        appendStroke(state, requireDrawer(), command.stroke, now);
        break;
      }
      case "undo":
        undo(state, requireDrawer(), now);
        break;
      case "clear":
        clear(state, requireDrawer(), now);
        break;
      case "select_winner":
        requireController();
        selectWinner(state, command.playerId, now);
        await this.ctx.storage.deleteAlarm();
        break;
      case "no_winner":
        requireController();
        selectNoWinner(state, now, Math.random);
        await this.ctx.storage.deleteAlarm();
        break;
      case "next_turn":
        requireController();
        nextTurn(state, now);
        break;
      case "cancel_turn":
        requireController();
        cancelTurn(state, now);
        await this.ctx.storage.deleteAlarm();
        break;
      case "end_game":
        requireController();
        endGame(state, now);
        await this.ctx.storage.deleteAlarm();
        break;
      default:
        command satisfies never;
    }
    this.persist();
    await this.scheduleNextAlarm();
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
    return row ? JSON.parse(row.payload) as RoomState : null;
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
    await this.ctx.storage.setAlarm(deadline ?? state.updatedAt + ROOM_TTL_MS);
  }
}
