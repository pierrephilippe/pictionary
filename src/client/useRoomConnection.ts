import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomSnapshot } from "../domain/types";
import type { ClientCommand } from "../shared/protocol";
import { parseServerMessage, reduceRoomMessage } from "./room-state";
import { requestJson, roomSocketUrl, type StoredSession } from "./session";

const RECONNECT_MAX_DELAY_MS = 8_000;

export function useRoomConnection(session: StoredSession | null) {
  const socketRef = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const generationRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [commandErrorSequence, setCommandErrorSequence] = useState(0);
  const [connected, setConnected] = useState(false);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const [roomDeleted, setRoomDeleted] = useState(false);
  const retryRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    snapshotRef.current = null;
    setSnapshot(null);
    setConnectionError(null);
    setCommandErrorSequence(0);
    setConnected(false);
    setSessionUnavailable(false);
    setRoomDeleted(false);
    if (!session) return undefined;

    let disposed = false;
    let connecting = false;
    let fatal = false;
    let suspended = false;
    let reconnectTimer: number | null = null;
    let ticketController: AbortController | null = null;
    const candidates = new Set<WebSocket>();

    const isCurrent = (candidate?: WebSocket): boolean => !disposed
      && generationRef.current === generation
      && (!candidate || socketRef.current === candidate);
    const stopReconnectTimer = (): void => {
      if (reconnectTimer === null) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };
    const scheduleReconnect = (immediately = false): void => {
      if (disposed || fatal || suspended || reconnectTimer !== null) return;
      if (!navigator.onLine) {
        setConnectionError("Connexion Internet indisponible. La partie reprendra dès le retour du réseau.");
        return;
      }
      const attempt = reconnectAttemptRef.current;
      const delay = immediately ? 0 : Math.min(RECONNECT_MAX_DELAY_MS, 500 * 2 ** attempt) + Math.round(Math.random() * 250);
      reconnectAttemptRef.current = Math.min(attempt + 1, 5);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };
    const closeForResync = (candidate: WebSocket): void => {
      if (!isCurrent(candidate)) return;
      setConnectionError("Le dessin se resynchronise…");
      candidate.close(4000, "Resync required");
    };
    const connect = async (): Promise<void> => {
      const activeState = socketRef.current?.readyState;
      if (disposed || fatal || connecting || activeState === WebSocket.CONNECTING || activeState === WebSocket.OPEN) return;
      if (!navigator.onLine) {
        setConnectionError("Connexion Internet indisponible. La partie reprendra dès le retour du réseau.");
        return;
      }
      connecting = true;
      ticketController?.abort();
      const controller = new AbortController();
      ticketController = controller;
      try {
        const ticket = await requestJson<{ ticket: string }>(`/api/rooms/${session.code}/ticket`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.token}` },
          signal: controller.signal,
        });
        if (!isCurrent() || controller.signal.aborted) return;
        const candidate = new WebSocket(roomSocketUrl(session.code, ticket.ticket));
        candidates.add(candidate);
        socketRef.current = candidate;
        candidate.onopen = () => {
          if (!isCurrent(candidate)) return;
          reconnectAttemptRef.current = 0;
          setConnected(true);
          setConnectionError(null);
        };
        candidate.onmessage = (event) => {
          if (!isCurrent(candidate)) return;
          try {
            const message = parseServerMessage(JSON.parse(String(event.data)));
            if (!message) throw new Error("invalid message");
            if (message.type === "error") {
              setConnectionError(message.message || "Commande refusée.");
              setCommandErrorSequence((sequence) => sequence + 1);
              return;
            }
            const result = reduceRoomMessage(snapshotRef.current, message);
            snapshotRef.current = result.snapshot;
            setSnapshot(result.snapshot);
            setConnectionError(null);
            if (result.needsResync) closeForResync(candidate);
          } catch {
            setConnectionError("Réponse serveur illisible. Resynchronisation…");
            closeForResync(candidate);
          }
        };
        candidate.onclose = (event) => {
          candidates.delete(candidate);
          if (!isCurrent(candidate)) return;
          socketRef.current = null;
          setConnected(false);
          if (event.reason === "Session replaced") {
            suspended = true;
            setConnectionError("Cette partie est ouverte dans un autre onglet. Reprenez-la ici uniquement si nécessaire.");
            return;
          }
          if (event.code === 1001 && event.reason === "Room expired") {
            fatal = true;
            setSessionUnavailable(true);
            setConnectionError("Cette salle a expiré.");
            return;
          }
          if (event.code === 4004 && event.reason === "Room deleted") {
            fatal = true;
            setSessionUnavailable(true);
            setRoomDeleted(true);
            setConnectionError("Cette partie a été supprimée par son organisateur.");
            return;
          }
          scheduleReconnect();
        };
        candidate.onerror = () => {
          if (isCurrent(candidate)) setConnectionError("La connexion temps réel a rencontré un problème.");
        };
      } catch (error) {
        if (!isCurrent() || controller.signal.aborted) return;
        setConnected(false);
        const message = error instanceof Error ? error.message : "Connexion impossible.";
        setConnectionError(message);
        fatal = message === "Cette salle n’existe plus." || message === "Session invalide.";
        setSessionUnavailable(fatal);
        if (!fatal) scheduleReconnect();
      } finally {
        if (ticketController === controller) ticketController = null;
        connecting = false;
      }
    };
    const reconnectAutomatically = (): void => {
      if (disposed || fatal || suspended) return;
      const state = socketRef.current?.readyState;
      if (state === WebSocket.CONNECTING || state === WebSocket.OPEN) return;
      stopReconnectTimer();
      void connect();
    };
    const retryNow = (): void => {
      if (disposed || fatal) return;
      suspended = false;
      reconnectAutomatically();
    };
    retryRef.current = retryNow;
    const recoverWhenVisible = (): void => {
      if (document.visibilityState === "visible") reconnectAutomatically();
    };
    window.addEventListener("online", reconnectAutomatically);
    document.addEventListener("visibilitychange", recoverWhenVisible);
    void connect();
    return () => {
      disposed = true;
      window.removeEventListener("online", reconnectAutomatically);
      document.removeEventListener("visibilitychange", recoverWhenVisible);
      stopReconnectTimer();
      ticketController?.abort();
      for (const candidate of candidates) candidate.close(1000, "Session changed");
      candidates.clear();
      socketRef.current = null;
      retryRef.current = () => undefined;
    };
  }, [session?.code, session?.token]);

  const send = useCallback((command: ClientCommand): boolean => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setConnected(false);
      setConnectionError("Connexion en cours de rétablissement.");
      return false;
    }
    try {
      socket.send(JSON.stringify(command));
      return true;
    } catch {
      setConnected(false);
      setConnectionError("Envoi impossible. Reconnexion en cours…");
      try {
        socket.close(4001, "Send failed");
      } catch {
        // The close event may already be queued by the browser.
      }
      return false;
    }
  }, []);

  const retry = useCallback(() => retryRef.current(), []);
  return { snapshot, connectionError, commandErrorSequence, connected, retry, send, sessionUnavailable, roomDeleted };
}
