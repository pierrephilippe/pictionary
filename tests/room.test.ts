import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomSnapshot } from "../src/domain/types";

interface SessionResponse {
  code: string;
  token: string;
  playerId?: string;
}

interface ServerMessage {
  type: "snapshot" | "stroke_delta" | "error";
  snapshot?: RoomSnapshot;
  message?: string;
}

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const waitForMessage = (
  socket: WebSocket,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> => new Promise((resolve, reject) => {
  const listener = (event: MessageEvent): void => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    if (!predicate(message)) return;
    clearTimeout(timer);
    socket.removeEventListener("message", listener);
    resolve(message);
  };
  const timer = setTimeout(() => {
    socket.removeEventListener("message", listener);
    reject(new Error("Délai de réponse WebSocket dépassé."));
  }, 2_000);
  socket.addEventListener("message", listener);
});

const openSocket = async (code: string, token: string): Promise<WebSocket> => {
  const ticketResponse = await SELF.fetch(`https://example.test/api/rooms/${code}/ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(ticketResponse.status).toBe(200);
  const { ticket } = await json<{ ticket: string }>(ticketResponse);
  const response = await SELF.fetch(`https://example.test/api/rooms/${code}/socket?ticket=${ticket}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("WebSocket absent.");
  socket.accept();
  await waitForMessage(socket, (message) => message.type === "snapshot");
  return socket;
};

const send = async (
  socket: WebSocket,
  command: unknown,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> => {
  const response = waitForMessage(socket, predicate);
  socket.send(JSON.stringify(command));
  return response;
};

describe("Worker et Durable Object de salle", () => {
  it("applique les rôles et refuse une seconde validation de résultat", async () => {
    const roomResponse = await SELF.fetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(roomResponse.status).toBe(201);
    const controller = await json<SessionResponse>(roomResponse);

    const join = async (name: string): Promise<SessionResponse> => {
      const response = await SELF.fetch(`https://example.test/api/rooms/${controller.code}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "player", name }),
      });
      expect(response.status).toBe(201);
      return json<SessionResponse>(response);
    };
    const firstPlayer = await join("Lila");
    const secondPlayer = await join("Noé");

    const controllerSocket = await openSocket(controller.code, controller.token);
    const firstSocket = await openSocket(controller.code, firstPlayer.token);
    const secondSocket = await openSocket(controller.code, secondPlayer.token);

    const rejected = await send(firstSocket, { type: "start_game" }, (message) => message.type === "error");
    expect(rejected).toMatchObject({ type: "error", message: "Réservé au contrôleur de jeu." });

    const started = await send(controllerSocket, { type: "start_game" }, (message) => message.type === "snapshot" && message.snapshot?.phase === "awaiting_ready");
    expect(started.snapshot?.phase).toBe("awaiting_ready");
    const drawerId = started.snapshot?.turn?.drawerId;
    const turnId = started.snapshot?.turn?.id;
    const drawerSocket = drawerId === firstPlayer.playerId ? firstSocket : secondSocket;
    const winnerId = drawerId === firstPlayer.playerId ? secondPlayer.playerId : firstPlayer.playerId;
    if (!winnerId || !turnId) throw new Error("Tour ou gagnant absent.");

    const restarted = await send(controllerSocket, { type: "cancel_turn", turnId }, (message) => message.type === "snapshot" && message.snapshot?.turn?.id !== turnId);
    const restartedTurnId = restarted.snapshot?.turn?.id;
    if (!restartedTurnId) throw new Error("Nouveau tour absent.");
    const stale = await send(drawerSocket, { type: "ready", turnId }, (message) => message.type === "error");
    expect(stale).toMatchObject({ type: "error", message: "Cette commande concerne un tour déjà terminé." });

    expect((await send(drawerSocket, { type: "ready", turnId: restartedTurnId }, (message) => message.type === "snapshot" && message.snapshot?.phase === "armed")).snapshot?.phase).toBe("armed");
    const stroke = await send(drawerSocket, {
      type: "stroke",
      turnId: restartedTurnId,
      stroke: {
        id: "server-test-stroke",
        tool: "pen",
        width: 8,
        points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
        complete: true,
      },
    }, (message) => message.type === "stroke_delta");
    expect(stroke.type).toBe("stroke_delta");

    const resolved = await send(controllerSocket, { type: "select_winner", turnId: restartedTurnId, playerId: winnerId }, (message) => message.type === "snapshot" && message.snapshot?.turn?.resolutionPending === false);
    expect(resolved.snapshot?.phase).toBe("revealing");
    expect(resolved.snapshot?.turn?.resolutionPending).toBe(false);

    const duplicate = await send(controllerSocket, { type: "no_winner", turnId: restartedTurnId }, (message) => message.type === "error");
    expect(duplicate).toMatchObject({ type: "error", message: "Le résultat de ce tour est déjà validé." });

    controllerSocket.close();
    firstSocket.close();
    secondSocket.close();
  });
});
