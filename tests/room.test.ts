import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomSnapshot } from "../src/domain/types";

interface SessionResponse {
  code: string;
  token: string;
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
  it("sépare joueurs et terminaux, et laisse le dessinateur valider le gagnant", async () => {
    const roomResponse = await SELF.fetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(roomResponse.status).toBe(201);
    const controller = await json<SessionResponse>(roomResponse);

    const joinTerminal = async (): Promise<SessionResponse> => {
      const response = await SELF.fetch(`https://example.test/api/rooms/${controller.code}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "terminal" }),
      });
      expect(response.status).toBe(201);
      return json<SessionResponse>(response);
    };
    const firstTerminal = await joinTerminal();
    const secondTerminal = await joinTerminal();

    const controllerSocket = await openSocket(controller.code, controller.token);
    const firstSocket = await openSocket(controller.code, firstTerminal.token);
    const secondSocket = await openSocket(controller.code, secondTerminal.token);

    const rejected = await send(firstSocket, { type: "start_game" }, (message) => message.type === "error");
    expect(rejected).toMatchObject({ type: "error", message: "Réservé au contrôleur de jeu." });

    expect((await send(controllerSocket, { type: "add_player", name: "Lila" }, (message) => message.type === "snapshot" && message.snapshot?.players.length === 1)).snapshot?.players).toHaveLength(1);
    expect((await send(controllerSocket, { type: "add_player", name: "Noé" }, (message) => message.type === "snapshot" && message.snapshot?.players.length === 2)).snapshot?.players).toHaveLength(2);
    const started = await send(controllerSocket, { type: "start_game" }, (message) => message.type === "snapshot" && message.snapshot?.phase === "awaiting_ready");
    expect(started.snapshot?.phase).toBe("awaiting_ready");
    const drawerId = started.snapshot?.turn?.drawerId;
    const turnId = started.snapshot?.turn?.id;
    const drawerSocket = firstSocket;
    const winnerId = started.snapshot?.players.find((player) => player.id !== drawerId)?.id;
    if (!winnerId || !turnId) throw new Error("Tour ou gagnant absent.");

    const controllerClaim = await send(controllerSocket, { type: "take_drawing_turn", turnId }, (message) => message.type === "error");
    expect(controllerClaim).toMatchObject({ type: "error", message: "Réservé à un téléphone de dessin." });

    expect((await send(drawerSocket, { type: "take_drawing_turn", turnId }, (message) => message.type === "snapshot" && message.snapshot?.canDraw === true)).snapshot?.canDraw).toBe(true);
    expect((await send(drawerSocket, { type: "ready", turnId }, (message) => message.type === "snapshot" && message.snapshot?.phase === "armed")).snapshot?.phase).toBe("armed");
    const drawing = await send(drawerSocket, {
      type: "stroke",
      turnId,
      stroke: {
        id: "server-test-stroke",
        tool: "pen",
        width: 8,
        points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
        complete: true,
      },
    }, (message) => message.type === "snapshot" && message.snapshot?.phase === "drawing");
    expect(drawing.snapshot?.turn?.deadlineAt).toBeTruthy();

    const cleared = await send(drawerSocket, { type: "clear", turnId }, (message) => message.type === "snapshot" && message.snapshot?.turn?.strokes.length === 0);
    expect(cleared.snapshot?.turn?.strokes).toEqual([]);

    const otherTerminalWinner = await send(secondSocket, { type: "select_winner", turnId, playerId: winnerId }, (message) => message.type === "error");
    expect(otherTerminalWinner).toMatchObject({ type: "error", message: "Ce téléphone n’est pas le terminal de dessin de ce tour." });

    const otherTerminalNoWinner = await send(secondSocket, { type: "no_winner", turnId }, (message) => message.type === "error");
    expect(otherTerminalNoWinner).toMatchObject({ type: "error", message: "Ce téléphone n’est pas le terminal de dessin de ce tour." });

    const resolved = await send(drawerSocket, { type: "select_winner", turnId, playerId: winnerId }, (message) => message.type === "snapshot" && message.snapshot?.phase === "revealing");
    expect(resolved.snapshot?.phase).toBe("revealing");
    expect(resolved.snapshot?.turn?.winnerId).toBe(winnerId);
    expect(resolved.snapshot?.players.map((player) => player.score)).toEqual([1, 1]);

    const duplicate = await send(drawerSocket, { type: "select_winner", turnId, playerId: winnerId }, (message) => message.type === "error");
    expect(duplicate).toMatchObject({ type: "error", message: "Le tour n’est plus en cours." });

    controllerSocket.close();
    firstSocket.close();
    secondSocket.close();
  });

  it("borne le nombre de terminaux persistés dans une salle", async () => {
    const roomResponse = await SELF.fetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    for (let index = 0; index < 16; index += 1) {
      const response = await SELF.fetch(`https://example.test/api/rooms/${controller.code}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "terminal" }),
      });
      expect(response.status).toBe(201);
    }

    const rejected = await SELF.fetch(`https://example.test/api/rooms/${controller.code}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "terminal" }),
    });
    expect(rejected.status).toBe(429);
    await expect(json<{ error: string }>(rejected)).resolves.toEqual({ error: "La limite de téléphones terminaux est atteinte." });
  });

  it("autorise un terminal libre à passer de la projection au dessin", async () => {
    const roomResponse = await SELF.fetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    const joined = await SELF.fetch(`https://example.test/api/rooms/${controller.code}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "terminal" }),
    });
    const terminal = await json<SessionResponse>(joined);
    const controllerSocket = await openSocket(controller.code, controller.token);
    const terminalSocket = await openSocket(controller.code, terminal.token);

    await send(controllerSocket, { type: "add_player", name: "Lila" }, (message) => message.type === "snapshot" && message.snapshot?.players.length === 1);
    const started = await send(controllerSocket, { type: "start_game" }, (message) => message.type === "snapshot" && message.snapshot?.phase === "awaiting_ready");
    const turnId = started.snapshot?.turn?.id;
    if (!turnId) throw new Error("Tour absent.");

    const projection = await send(terminalSocket, { type: "set_display_mode", displayMode: "projection" }, (message) => message.type === "snapshot" && message.snapshot?.displayMode === "projection");
    expect(projection.snapshot?.displayMode).toBe("projection");
    expect(projection.snapshot?.secretWord).toBeNull();

    const rejected = await send(terminalSocket, { type: "take_drawing_turn", turnId }, (message) => message.type === "error");
    expect(rejected).toMatchObject({ type: "error", message: "Ce téléphone est en mode projecteur." });

    const drawing = await send(terminalSocket, { type: "set_display_mode", displayMode: "drawing" }, (message) => message.type === "snapshot" && message.snapshot?.displayMode === "drawing");
    expect(drawing.snapshot?.canTakeDrawingTurn).toBe(true);
    controllerSocket.close();
    terminalSocket.close();
  });

  it("borne les WebSockets actifs d’une salle", async () => {
    const roomResponse = await SELF.fetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 20; index += 1) sockets.push(await openSocket(controller.code, controller.token));

    const ticketResponse = await SELF.fetch(`https://example.test/api/rooms/${controller.code}/ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${controller.token}` },
    });
    const { ticket } = await json<{ ticket: string }>(ticketResponse);
    const rejected = await SELF.fetch(`https://example.test/api/rooms/${controller.code}/socket?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(rejected.status).toBe(429);

    for (const socket of sockets) socket.close();
  });
});
