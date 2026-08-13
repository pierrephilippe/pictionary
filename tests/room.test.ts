import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { REVEAL_DURATION_MS } from "../src/domain/game";
import { DEFAULT_SETTINGS, type RoomSnapshot, type RoomState, type Stroke } from "../src/domain/types";

interface SessionResponse {
  code: string;
  token: string;
}

interface ServerMessage {
  type: "snapshot" | "stroke_delta" | "error";
  snapshot?: RoomSnapshot;
  message?: string;
  revision?: number;
  turnId?: string;
  canvasRevision?: number;
  offset?: number;
  stroke?: Stroke;
}

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;
let requestActor = 0;
const workerFetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (!headers.has("CF-Connecting-IP")) {
    requestActor += 1;
    headers.set("CF-Connecting-IP", `192.0.2.${requestActor}`);
  }
  return SELF.fetch(input, { ...init, headers });
};

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

const waitForClose = (socket: WebSocket): Promise<CloseEvent> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Délai de fermeture WebSocket dépassé.")), 2_000);
  socket.addEventListener("close", (event) => {
    clearTimeout(timer);
    resolve(event);
  }, { once: true });
});

const openSocket = async (code: string, token: string): Promise<WebSocket> => {
  const ticketResponse = await workerFetch(`https://example.test/api/rooms/${code}/ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(ticketResponse.status).toBe(200);
  const { ticket } = await json<{ ticket: string }>(ticketResponse);
  const response = await workerFetch(`https://example.test/api/rooms/${code}/socket?ticket=${ticket}`, {
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
  it("borne et valide les entrées HTTP, sans exposer de réponse API sans protections", async () => {
    const malformed = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unexpected: true }),
    });
    expect(malformed.status).toBe(400);
    await expect(json<{ error: string }>(malformed)).resolves.toEqual({ error: "La requête de création est invalide." });
    expect(malformed.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(malformed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(malformed.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");

    const oversized = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(4_100) }),
    });
    expect(oversized.status).toBe(400);
    await expect(json<{ error: string }>(oversized)).resolves.toEqual({ error: "La requête est trop volumineuse." });
  });

  it("ne crée aucune table Durable Object lorsqu’une salle inconnue est rejointe", async () => {
    const code = "ZZZZZZ";
    const response = await workerFetch(`https://example.test/api/rooms/${code}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "terminal" }),
    });
    expect(response.status).toBe(404);

    const stub = env.GAME_ROOM.getByName(`room:${code}`);
    await runInDurableObject(stub, (_instance, state) => {
      const tables = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_state'",
      ).toArray();
      expect(tables).toEqual([]);
    });
  });

  it("refuse une ouverture WebSocket provenant d’une autre origine", async () => {
    const response = await SELF.fetch("https://example.test/api/rooms/AAAAAA/socket?ticket=unused", {
      headers: { Upgrade: "websocket", Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    await expect(json<{ error: string }>(response)).resolves.toEqual({ error: "Origine de connexion refusée." });
  });

  it("migre un état version 1 sans conserver le réglage de thème", async () => {
    const code = "MGRA23";
    const stub = env.GAME_ROOM.getByName(`room:${code}`);
    const legacyState = {
      version: 1,
      code,
      createdAt: 1_000,
      updatedAt: 2_000,
      phase: "lobby",
      settings: { durationSeconds: 90, rounds: 5, themes: ["animaux"], difficulties: ["moyen"] },
      players: [],
      sessions: [{ id: "legacy-controller", token: "legacy-token", role: "controller", createdAt: 1_000, lastSeenAt: 2_000 }],
      tickets: [],
      turnSequence: 0,
      current: null,
      usedWordIds: [],
      finishedWinnerIds: [],
    };
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE room_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)");
      state.storage.sql.exec("INSERT INTO room_state (id, payload) VALUES (1, ?)", JSON.stringify(legacyState));
    });
    await evictDurableObject(stub);

    const result = await stub.join({ role: "terminal" });
    expect(result).toHaveProperty("token");
    await runInDurableObject(stub, (_instance, state) => {
      const payload = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM room_state WHERE id = 1").one().payload;
      const migrated = JSON.parse(payload) as Record<string, unknown> & { settings: Record<string, unknown> };
      expect(migrated.version).toBe(2);
      expect(migrated.revision).toBe(1);
      expect(migrated.lastActivityAt).toEqual(expect.any(Number));
      expect(migrated.settings).toEqual({ durationSeconds: 90, rounds: 5, difficulties: ["moyen"] });
    });
  });

  it("expire une salle inactive avant d’appliquer une transition de manche", async () => {
    const roomResponse = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    const stub = env.GAME_ROOM.getByName(`room:${controller.code}`);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM room_state WHERE id = 1").one();
      const persisted = JSON.parse(row.payload) as Record<string, unknown>;
      persisted.lastActivityAt = Date.now() - 2 * 60 * 60 * 1_000 - 1;
      state.storage.sql.exec("UPDATE room_state SET payload = ? WHERE id = 1", JSON.stringify(persisted));
      return state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(stub);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM room_state").one().count).toBe(0);
    });
  });

  it("ne prolonge pas une salle inactive avec un ticket ou un handshake WebSocket", async () => {
    const roomResponse = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    const stub = env.GAME_ROOM.getByName(`room:${controller.code}`);
    const activityAt = Date.now() - 60 * 60 * 1_000;
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM room_state WHERE id = 1").one();
      const persisted = JSON.parse(row.payload) as Record<string, unknown>;
      persisted.lastActivityAt = activityAt;
      state.storage.sql.exec("UPDATE room_state SET payload = ? WHERE id = 1", JSON.stringify(persisted));
    });
    await evictDurableObject(stub);

    const ticketResponse = await workerFetch(`https://example.test/api/rooms/${controller.code}/ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${controller.token}` },
    });
    expect(ticketResponse.status).toBe(200);
    const { ticket } = await json<{ ticket: string }>(ticketResponse);
    const socketResponse = await workerFetch(`https://example.test/api/rooms/${controller.code}/socket?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(socketResponse.status).toBe(101);
    socketResponse.webSocket?.accept();

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM room_state WHERE id = 1").one();
      const persisted = JSON.parse(row.payload) as { lastActivityAt: number };
      expect(persisted.lastActivityAt).toBe(activityAt);
      persisted.lastActivityAt = Date.now() - 2 * 60 * 60 * 1_000 - 1;
      state.storage.sql.exec("UPDATE room_state SET payload = ? WHERE id = 1", JSON.stringify(persisted));
      return state.storage.setAlarm(Date.now());
    });
    socketResponse.webSocket?.close();
    await evictDurableObject(stub);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM room_state").one().count).toBe(0);
    });
  });

  it("refuse les propriétés inattendues dans les commandes WebSocket", async () => {
    const roomResponse = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    const controllerSocket = await openSocket(controller.code, controller.token);

    const rejected = await send(controllerSocket, { type: "start_game", settings: DEFAULT_SETTINGS, elevated: true }, (message) => message.type === "error");
    expect(rejected).toMatchObject({ type: "error", message: "Commande invalide." });
    controllerSocket.close();
  });

  it("limite aussi les commandes WebSocket rejetées", async () => {
    const roomResponse = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    const controllerSocket = await openSocket(controller.code, controller.token);

    for (let index = 0; index < 40; index += 1) {
      const rejected = await send(
        controllerSocket,
        { type: "start_game", settings: DEFAULT_SETTINGS, elevated: true },
        (message) => message.type === "error",
      );
      expect(rejected).toMatchObject({ type: "error", message: "Commande invalide." });
    }

    const closed = waitForClose(controllerSocket);
    controllerSocket.send(JSON.stringify({ type: "start_game", settings: DEFAULT_SETTINGS, elevated: true }));
    await expect(closed).resolves.toMatchObject({ code: 1008 });
  });

  it("sépare joueurs et terminaux, et laisse le dessinateur valider le gagnant", async () => {
    const roomResponse = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(roomResponse.status).toBe(201);
    const controller = await json<SessionResponse>(roomResponse);

    const joinTerminal = async (): Promise<SessionResponse> => {
      const response = await workerFetch(`https://example.test/api/rooms/${controller.code}/join`, {
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

    const rejected = await send(firstSocket, { type: "start_game", settings: DEFAULT_SETTINGS }, (message) => message.type === "error");
    expect(rejected).toMatchObject({ type: "error", message: "Réservé au contrôleur de jeu." });

    expect((await send(controllerSocket, { type: "add_player", name: "Lila" }, (message) => message.type === "snapshot" && message.snapshot?.players.length === 1)).snapshot?.players).toHaveLength(1);
    expect((await send(controllerSocket, { type: "add_player", name: "Noé" }, (message) => message.type === "snapshot" && message.snapshot?.players.length === 2)).snapshot?.players).toHaveLength(2);
    const started = await send(controllerSocket, { type: "start_game", settings: { ...DEFAULT_SETTINGS, durationSeconds: 30, rounds: 5, difficulties: ["moyen"] } }, (message) => message.type === "snapshot" && message.snapshot?.phase === "awaiting_ready");
    expect(started.snapshot?.phase).toBe("awaiting_ready");
    expect(started.snapshot?.settings).toEqual({ durationSeconds: 30, rounds: 5, difficulties: ["moyen"] });
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
      canvasRevision: started.snapshot?.turn?.canvasRevision ?? 0,
      stroke: {
        id: "server-test-stroke",
        tool: "pen",
        width: 8,
        points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
        complete: false,
      },
    }, (message) => message.type === "snapshot" && message.snapshot?.phase === "drawing");
    expect(drawing.snapshot?.turn?.deadlineAt).toBeTruthy();

    const delta = await send(drawerSocket, {
      type: "stroke",
      turnId,
      canvasRevision: drawing.snapshot?.turn?.canvasRevision ?? 0,
      stroke: {
        id: "server-test-stroke",
        tool: "pen",
        width: 8,
        points: [{ x: 0.3, y: 0.3 }],
        complete: true,
      },
    }, (message) => message.type === "stroke_delta");
    expect(delta).toMatchObject({
      type: "stroke_delta",
      turnId,
      canvasRevision: 0,
      offset: 2,
    });
    expect(delta.revision).toBeGreaterThan(drawing.snapshot?.revision ?? 0);

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
    expect(duplicate).toMatchObject({ type: "error", message: "La manche ne peut plus être résolue." });

    controllerSocket.close();
    firstSocket.close();
    secondSocket.close();
  });

  it("attend la décision du dessinateur après le chrono puis donne la main au gagnant", async () => {
    const roomResponse = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    const terminalResponse = await workerFetch(`https://example.test/api/rooms/${controller.code}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "terminal" }),
    });
    const terminal = await json<SessionResponse>(terminalResponse);
    const controllerSocket = await openSocket(controller.code, controller.token);
    const drawerSocket = await openSocket(controller.code, terminal.token);

    await send(controllerSocket, { type: "add_player", name: "Lila" }, (message) => message.type === "snapshot" && message.snapshot?.players.length === 1);
    await send(controllerSocket, { type: "add_player", name: "Noé" }, (message) => message.type === "snapshot" && message.snapshot?.players.length === 2);
    const started = await send(controllerSocket, { type: "start_game", settings: DEFAULT_SETTINGS }, (message) => message.type === "snapshot" && message.snapshot?.phase === "awaiting_ready");
    const turnId = started.snapshot?.turn?.id;
    const drawerId = started.snapshot?.turn?.drawerId;
    const winnerId = started.snapshot?.players.find((player) => player.id !== drawerId)?.id;
    if (!turnId || !winnerId) throw new Error("Tour ou gagnant absent.");

    await send(drawerSocket, { type: "take_drawing_turn", turnId }, (message) => message.type === "snapshot" && message.snapshot?.canDraw === true);
    await send(drawerSocket, { type: "ready", turnId }, (message) => message.type === "snapshot" && message.snapshot?.phase === "armed");
    await send(drawerSocket, {
      type: "stroke",
      turnId,
      canvasRevision: 0,
      stroke: { id: "timeout-stroke", tool: "pen", width: 8, points: [{ x: 0.2, y: 0.2 }], complete: true },
    }, (message) => message.type === "snapshot" && message.snapshot?.phase === "drawing");
    controllerSocket.close();
    drawerSocket.close();

    const stub = env.GAME_ROOM.getByName(`room:${controller.code}`);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM room_state WHERE id = 1").one();
      const persisted = JSON.parse(row.payload) as RoomState;
      if (!persisted.current) throw new Error("Tour persistant absent.");
      persisted.current.deadlineAt = Date.now() - 1;
      state.storage.sql.exec("UPDATE room_state SET payload = ? WHERE id = 1", JSON.stringify(persisted));
      return state.storage.setAlarm(Date.now());
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM room_state WHERE id = 1").one();
      const persisted = JSON.parse(row.payload) as RoomState;
      expect(persisted.phase).toBe("resolving");
      expect(persisted.current?.winnerId).toBeNull();
      expect(persisted.current?.nextDrawerId).toBeNull();
    });

    const resolvingDrawerSocket = await openSocket(controller.code, terminal.token);
    const resolved = await send(resolvingDrawerSocket, { type: "select_winner", turnId, playerId: winnerId }, (message) => message.type === "snapshot" && message.snapshot?.phase === "revealing");
    expect(resolved.snapshot?.turn?.winnerId).toBe(winnerId);
    expect(resolved.snapshot?.turn?.nextDrawerId).toBe(winnerId);
    resolvingDrawerSocket.close();

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM room_state WHERE id = 1").one();
      const persisted = JSON.parse(row.payload) as RoomState;
      if (!persisted.current) throw new Error("Tour persistant absent.");
      persisted.current.revealedAt = Date.now() - REVEAL_DURATION_MS;
      state.storage.sql.exec("UPDATE room_state SET payload = ? WHERE id = 1", JSON.stringify(persisted));
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM room_state WHERE id = 1").one();
      const persisted = JSON.parse(row.payload) as RoomState;
      expect(persisted.phase).toBe("awaiting_ready");
      expect(persisted.current?.round).toBe(2);
      expect(persisted.current?.drawerId).toBe(winnerId);
    });
  });

  it("borne le nombre de terminaux persistés dans une salle", async () => {
    const roomResponse = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    for (let index = 0; index < 16; index += 1) {
      const response = await workerFetch(`https://example.test/api/rooms/${controller.code}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "terminal" }),
      });
      expect(response.status).toBe(201);
    }

    const rejected = await workerFetch(`https://example.test/api/rooms/${controller.code}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "terminal" }),
    });
    expect(rejected.status).toBe(429);
    await expect(json<{ error: string }>(rejected)).resolves.toEqual({ error: "La limite de téléphones terminaux est atteinte." });
  });

  it("autorise un terminal libre à passer de la projection au dessin", async () => {
    const roomResponse = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    const joined = await workerFetch(`https://example.test/api/rooms/${controller.code}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "terminal" }),
    });
    const terminal = await json<SessionResponse>(joined);
    const controllerSocket = await openSocket(controller.code, controller.token);
    const terminalSocket = await openSocket(controller.code, terminal.token);

    await send(controllerSocket, { type: "add_player", name: "Lila" }, (message) => message.type === "snapshot" && message.snapshot?.players.length === 1);
    const started = await send(controllerSocket, { type: "start_game", settings: DEFAULT_SETTINGS }, (message) => message.type === "snapshot" && message.snapshot?.phase === "awaiting_ready");
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

  it("remplace le WebSocket précédent d’une même session", async () => {
    const roomResponse = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    const firstSocket = await openSocket(controller.code, controller.token);
    const firstClosed = waitForClose(firstSocket);
    const replacementSocket = await openSocket(controller.code, controller.token);

    await expect(firstClosed).resolves.toMatchObject({ code: 1000, reason: "Session replaced" });
    expect(replacementSocket.readyState).toBe(WebSocket.OPEN);
    replacementSocket.close();
  });

  it("ferme les trames WebSocket binaires ou surdimensionnées avec le code 1009", async () => {
    const roomResponse = await workerFetch("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const controller = await json<SessionResponse>(roomResponse);
    const socket = await openSocket(controller.code, controller.token);
    const closed = waitForClose(socket);

    socket.send(new Uint8Array([1, 2, 3]).buffer);

    await expect(closed).resolves.toMatchObject({ code: 1009 });

    const oversizedSocket = await openSocket(controller.code, controller.token);
    const oversizedClosed = waitForClose(oversizedSocket);
    oversizedSocket.send("é".repeat(12_001));
    await expect(oversizedClosed).resolves.toMatchObject({ code: 1009 });
  });
});
