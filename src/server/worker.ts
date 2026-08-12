import type { JoinRoomRequest } from "../shared/protocol";
import { createRoomSchema, joinRoomSchema } from "../shared/protocol";
import { GameRuleError } from "../domain/game";
import { GameRoom } from "./room";

export { GameRoom } from "./room";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_JSON_BODY_BYTES = 4_096;

class RequestInputError extends Error {}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const json = (value: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  for (const [name, header] of Object.entries(SECURITY_HEADERS)) headers.set(name, header);
  return new Response(JSON.stringify(value), { ...init, headers });
};

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
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new RequestInputError("Le corps de la requête doit être du JSON.");
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new RequestInputError("La requête est trop volumineuse.");
  }
  if (!request.body) throw new RequestInputError("Le corps de la requête est requis.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new RequestInputError("La requête est trop volumineuse.");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as T;
  } catch (error) {
    if (error instanceof RequestInputError) throw error;
    throw new RequestInputError("Le corps de la requête doit être du JSON valide.");
  }
};

const bearerToken = (request: Request): string | null => {
  const value = request.headers.get("Authorization");
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]{32,64})$/);
  return match?.[1] ?? null;
};

const asStub = (env: Env, code: string) => env.GAME_ROOM.getByName(`room:${code}`);

const secureAssetResponse = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [name, header] of Object.entries(SECURITY_HEADERS)) headers.set(name, header);
  const path = new URL(request.url).pathname;
  if (path === "/sw.js" || path === "/manifest.webmanifest" || path === "/" || path === "/offline") headers.set("cache-control", "no-cache");
  if (path.startsWith("/assets/")) headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return secureAssetResponse(request, await env.ASSETS.fetch(request));
    if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, environment: env.ENVIRONMENT });

    try {
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        const input = createRoomSchema.safeParse(await readJson<unknown>(request));
        if (!input.success) throw new RequestInputError("La requête de création est invalide.");
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
        const input = joinRoomSchema.safeParse(await readJson<JoinRoomRequest>(request));
        if (!input.success) throw new RequestInputError("La demande de connexion est invalide.");
        const result = await stub.join(input.data);
        if ("error" in result) return errorResponse(result.error, 429);
        return json({ code, token: result.token, role: input.data.role }, { status: 201 });
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
      if (error instanceof RequestInputError) return errorResponse(error.message, 400);
      if (error instanceof GameRuleError) {
        if (error.message === "Cette salle n’existe plus.") return errorResponse(error.message, 404);
        if (error.message === "Session invalide.") return errorResponse(error.message, 401);
        return errorResponse(error.message, 400);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "pictiofady_api_error", path: url.pathname, message }));
      return errorResponse("Une erreur serveur est survenue.", 500);
    }
  },
} satisfies ExportedHandler<Env>;
