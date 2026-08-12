import type { JoinRoomRequest } from "../shared/protocol";
import { joinRoomSchema } from "../shared/protocol";
import { GameRoom } from "./room";

export { GameRoom } from "./room";

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
  ENVIRONMENT: "development" | "staging" | "production";
}

type GameRoomStub = DurableObjectStub & Pick<GameRoom, "create" | "join" | "issueTicket">;

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const json = (value: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(value), {
  ...init,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...init.headers,
  },
});

const errorResponse = (message: string, status = 400): Response => json({ error: message }, { status });

const newToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const newRoomCode = (): string => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join("");
};

const validRoomCode = (code: string): boolean => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code);

const readJson = async <T>(request: Request): Promise<T> => {
  try {
    return await request.json() as T;
  } catch {
    throw new Error("Le corps de la requête doit être du JSON valide.");
  }
};

const bearerToken = (request: Request): string | null => {
  const value = request.headers.get("Authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
};

const asStub = (env: Env, code: string): GameRoomStub => env.GAME_ROOM.getByName(`room:${code}`) as unknown as GameRoomStub;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, environment: env.ENVIRONMENT });

    try {
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        await readJson<Record<string, never>>(request);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const code = newRoomCode();
          const token = newToken();
          try {
            await asStub(env, code).create({ code, controllerToken: token });
            return json({ code, token, role: "controller" }, { status: 201 });
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "Ce code de salle existe déjà.") throw error;
          }
        }
        return errorResponse("Impossible de créer une salle, réessayez.", 503);
      }

      const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})(?:\/(join|ticket|socket))?$/);
      if (!match || !validRoomCode(match[1]!)) return errorResponse("Route inconnue.", 404);
      const [, code, action] = match;
      const stub = asStub(env, code!);

      if (request.method === "POST" && action === "join") {
        const input = joinRoomSchema.parse(await readJson<JoinRoomRequest>(request));
        const result = await stub.join(input);
        return json({ code, token: result.token, role: input.role, playerId: result.playerId }, { status: 201 });
      }

      if (request.method === "POST" && action === "ticket") {
        const token = bearerToken(request);
        if (!token) return errorResponse("Authentification requise.", 401);
        return json(await stub.issueTicket(token));
      }

      if (request.method === "GET" && action === "socket") {
        if (request.headers.get("Upgrade") !== "websocket") return errorResponse("Connexion WebSocket requise.", 426);
        const target = new URL(request.url);
        target.pathname = "/socket";
        return stub.fetch(new Request(target, request));
      }
      return errorResponse("Méthode non autorisée.", 405);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur serveur.";
      if (message === "Cette salle n’existe plus.") return errorResponse(message, 404);
      if (message === "Session invalide.") return errorResponse(message, 401);
      console.warn("pictionary_api_error", { path: url.pathname, message });
      return errorResponse(message, 400);
    }
  },
} satisfies ExportedHandler<Env>;
