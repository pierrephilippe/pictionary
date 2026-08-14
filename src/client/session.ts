export interface StoredSession {
  code: string;
  token: string;
  role: "controller" | "terminal";
}

interface ApiError {
  error?: string;
}

export const ROOM_CODE_LENGTH = 6;
export const REQUEST_TIMEOUT_MS = 12_000;

const ACTIVE_SESSION_KEY = "pictiofady.active-session";
const LEGACY_SESSION_KEY = "prisme.active-session";
const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

export const normaliseRoomCode = (code: string): string => code
  .toUpperCase()
  .replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, "")
  .slice(0, ROOM_CODE_LENGTH);

export const directJoinCode = (search = window.location.search): string => normaliseRoomCode(
  new URLSearchParams(search).get("join") ?? "",
);

export const clearDirectJoinUrl = (): void => {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("join")) return;
  url.searchParams.delete("join");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
};

export const saveSession = (session: StoredSession | null): void => {
  if (!session) {
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem(LEGACY_SESSION_KEY);
    return;
  }
  localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
  localStorage.removeItem(LEGACY_SESSION_KEY);
};

export const loadSession = (): StoredSession | null => {
  try {
    const value = localStorage.getItem(ACTIVE_SESSION_KEY) ?? localStorage.getItem(LEGACY_SESSION_KEY);
    const session = value ? JSON.parse(value) as Partial<StoredSession> : null;
    const validRole = session?.role === "controller" || session?.role === "terminal";
    const validCode = typeof session?.code === "string" && ROOM_CODE_PATTERN.test(session.code);
    const validToken = typeof session?.token === "string" && SESSION_TOKEN_PATTERN.test(session.token);
    return validRole && validCode && validToken ? session as StoredSession : null;
  } catch {
    return null;
  }
};

export const requestJson = async <T,>(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> => {
  const requestController = new AbortController();
  const callerSignal = init.signal;
  let timedOut = false;
  const abortFromCaller = (): void => requestController.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, timeoutMs);

  try {
    const response = await fetch(path, { ...init, signal: requestController.signal });
    let data: (T & ApiError) | null = null;
    try {
      data = await response.json() as T & ApiError;
    } catch {
      // A proxy or unavailable edge can return a non-JSON error page. Keep the
      // UI message stable without exposing that response body.
    }
    if (!response.ok) throw new Error(data?.error ?? "La requête a échoué.");
    if (!data) throw new Error("Réponse serveur illisible.");
    return data;
  } catch (error) {
    if (timedOut) throw new Error("Le serveur met trop de temps à répondre. Réessayez.");
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
};

export const roomSocketUrl = (code: string, ticket: string): string => {
  const url = new URL(`/api/rooms/${code}/socket`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
};
