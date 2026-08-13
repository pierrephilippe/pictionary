import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DIFFICULTIES,
  DURATIONS,
  ROUND_COUNTS,
  type Difficulty,
  type Point,
  type ProjectionLayout,
  type RoomSnapshot,
  type Settings,
  type Stroke,
  type Tool,
} from "../domain/types";
import type { ClientCommand, JoinRoomRequest } from "../shared/protocol";

const RoomQrCode = lazy(async () => {
  const module = await import("qrcode.react");
  return { default: module.QRCodeSVG };
});

interface StoredSession {
  code: string;
  token: string;
  role: "controller" | "terminal";
}

interface ApiError {
  error?: string;
}

type ServerMessage =
  | { type: "snapshot"; snapshot: RoomSnapshot }
  | { type: "stroke_delta"; round: number; stroke: Stroke }
  | { type: "error"; message?: string };

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PwaControls {
  canInstall: boolean;
  isInstalled: boolean;
  isAppleMobile: boolean;
  updateAvailable: boolean;
  install: () => Promise<void>;
  applyUpdate: () => void;
}

const ACTIVE_SESSION_KEY = "pictiofady.active-session";
const LEGACY_SESSION_KEY = "prisme.active-session";
const STROKE_CHUNK_SIZE = 96;
const CLEAR_CONFIRMATION_MS = 4_000;

const haptic = (pattern: number | number[]): void => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Haptics are an optional enhancement and are unavailable on many browsers.
  }
};

const request = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, init);
  const data = await response.json() as T & ApiError;
  if (!response.ok) throw new Error(data.error ?? "La requête a échoué.");
  return data;
};

const saveSession = (session: StoredSession | null): void => {
  if (!session) {
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem(LEGACY_SESSION_KEY);
    return;
  }
  localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
  localStorage.removeItem(LEGACY_SESSION_KEY);
};

const loadSession = (): StoredSession | null => {
  try {
    const value = localStorage.getItem(ACTIVE_SESSION_KEY) ?? localStorage.getItem(LEGACY_SESSION_KEY);
    const session = value ? JSON.parse(value) as StoredSession : null;
    const isValidRole = session?.role === "controller" || session?.role === "terminal";
    const isValidCode = typeof session?.code === "string" && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(session.code);
    const isValidToken = typeof session?.token === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(session.token);
    return isValidRole && isValidCode && isValidToken ? session : null;
  } catch {
    return null;
  }
};

const ROOM_CODE_LENGTH = 6;
const normaliseCode = (code: string): string => code.toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, "").slice(0, ROOM_CODE_LENGTH);

const directJoinCode = (): string => normaliseCode(new URLSearchParams(window.location.search).get("join") ?? "");

const clearDirectJoinUrl = (): void => {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("join")) return;
  url.searchParams.delete("join");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
};

const socketUrl = (code: string, ticket: string): string => {
  const url = new URL(`/api/rooms/${code}/socket`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
};

function usePwaLifecycle(): PwaControls {
  const deferredInstallRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) && !("MSStream" in window);
  const isInstalled = window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;

  useEffect(() => {
    const receiveInstallPrompt = (event: Event): void => {
      event.preventDefault();
      deferredInstallRef.current = event as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const installed = (): void => {
      deferredInstallRef.current = null;
      setCanInstall(false);
    };
    window.addEventListener("beforeinstallprompt", receiveInstallPrompt);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", receiveInstallPrompt);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    let disposed = false;
    const watchRegistration = (registration: ServiceWorkerRegistration): void => {
      if (registration.waiting) setUpdateAvailable(true);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (!disposed && worker.state === "installed" && navigator.serviceWorker.controller) setUpdateAvailable(true);
        });
      });
    };
    void navigator.serviceWorker.ready.then((registration) => {
      if (!disposed) watchRegistration(registration);
    });
    return () => { disposed = true; };
  }, []);

  const install = async (): Promise<void> => {
    const event = deferredInstallRef.current;
    if (!event) return;
    await event.prompt();
    await event.userChoice;
    deferredInstallRef.current = null;
    setCanInstall(false);
  };

  const applyUpdate = (): void => {
    if (!("serviceWorker" in navigator)) return;
    const reload = (): void => window.location.reload();
    navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
    void navigator.serviceWorker.getRegistration().then((registration) => {
      if (registration?.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
    });
  };

  return { canInstall, isInstalled, isAppleMobile, updateAvailable, install, applyUpdate };
}

function useRoomSocket(session: StoredSession | null) {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setSnapshot(null);
    setConnectionError(null);
    setConnected(false);
    if (!session) return undefined;
    let disposed = false;
    let connecting = false;
    let socket: WebSocket | null = null;

    const stopReconnectTimer = (): void => {
      if (reconnectRef.current === null) return;
      window.clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    };

    const scheduleReconnect = (immediately = false): void => {
      if (disposed || reconnectRef.current !== null) return;
      if (!navigator.onLine) {
        setConnectionError("Connexion Internet indisponible. La partie reprendra dès le retour du réseau.");
        return;
      }
      const attempt = reconnectAttemptRef.current;
      const delay = immediately ? 0 : Math.min(8_000, 500 * 2 ** attempt) + Math.round(Math.random() * 250);
      reconnectAttemptRef.current = Math.min(attempt + 1, 5);
      reconnectRef.current = window.setTimeout(() => {
        reconnectRef.current = null;
        void connect();
      }, delay);
    };

    const connect = async (): Promise<void> => {
      if (disposed || connecting || socketRef.current?.readyState === WebSocket.OPEN) return;
      if (!navigator.onLine) {
        setConnectionError("Connexion Internet indisponible. La partie reprendra dès le retour du réseau.");
        return;
      }
      connecting = true;
      try {
        const ticket = await request<{ ticket: string }>(`/api/rooms/${session.code}/ticket`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.token}` },
        });
        if (disposed) return;
        socket = new WebSocket(socketUrl(session.code, ticket.ticket));
        socketRef.current = socket;
        socket.onopen = () => {
          if (socketRef.current !== socket) return;
          reconnectAttemptRef.current = 0;
          setConnected(true);
          setConnectionError(null);
        };
        socket.onmessage = (event) => {
          if (socketRef.current !== socket) return;
          try {
            const message = JSON.parse(String(event.data)) as ServerMessage;
            if (message.type === "snapshot") {
              setSnapshot(message.snapshot);
              setConnectionError(null);
            }
            if (message.type === "stroke_delta") {
              setSnapshot((previous) => mergeStrokeDelta(previous, message.round, message.stroke));
            }
            if (message.type === "error") setConnectionError(message.message ?? "Commande refusée.");
          } catch {
            setConnectionError("Réponse serveur illisible.");
          }
        };
        socket.onclose = () => {
          if (socketRef.current !== socket) return;
          socketRef.current = null;
          setConnected(false);
          if (!disposed) scheduleReconnect();
        };
        socket.onerror = () => setConnectionError("La connexion temps réel a rencontré un problème.");
      } catch (error) {
        if (!disposed) {
          setConnected(false);
          const message = error instanceof Error ? error.message : "Connexion impossible.";
          setConnectionError(message);
          if (message === "Cette salle n’existe plus." || message === "Session invalide.") return;
          scheduleReconnect();
        }
      } finally {
        connecting = false;
      }
    };
    const reconnectNow = (): void => {
      stopReconnectTimer();
      void connect();
    };
    const recoverWhenVisible = (): void => {
      if (document.visibilityState === "visible" && socketRef.current?.readyState !== WebSocket.OPEN) reconnectNow();
    };
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", recoverWhenVisible);
    void connect();
    return () => {
      disposed = true;
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", recoverWhenVisible);
      stopReconnectTimer();
      socket?.close();
      socketRef.current = null;
    };
  }, [session?.code, session?.token]);

  const send = useCallback((command: ClientCommand): void => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setConnectionError("Connexion en cours de rétablissement.");
      return;
    }
    socketRef.current.send(JSON.stringify(command));
  }, []);

  return { snapshot, connectionError, connected, send };
}

const mergeStrokeDelta = (snapshot: RoomSnapshot | null, round: number, stroke: Stroke): RoomSnapshot | null => {
  if (!snapshot?.turn || snapshot.turn.round !== round) return snapshot;
  const currentStrokes = snapshot.turn.strokes;
  const strokeIndex = currentStrokes.findIndex((candidate) => candidate.id === stroke.id);
  if (strokeIndex >= 0 && currentStrokes[strokeIndex]!.complete) return snapshot;
  const strokes = strokeIndex >= 0
    ? currentStrokes.map((candidate, index) => index === strokeIndex
      ? { ...candidate, points: [...candidate.points, ...stroke.points], complete: candidate.complete || stroke.complete }
      : candidate)
    : [...currentStrokes, { ...stroke, points: [...stroke.points] }];
  return { ...snapshot, turn: { ...snapshot.turn, strokes } };
};

const formatTime = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

function useRemainingTime(deadlineAt: number | null, serverNow: number): number | null {
  const [now, setNow] = useState(Date.now());
  const [serverOffset, setServerOffset] = useState(() => serverNow - Date.now());
  useEffect(() => {
    setNow(Date.now());
    setServerOffset(serverNow - Date.now());
  }, [serverNow]);
  useEffect(() => {
    if (!deadlineAt) return undefined;
    // The display uses whole seconds. One update per second keeps four-view
    // projection inexpensive without making the countdown feel less precise.
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [deadlineAt]);
  return deadlineAt ? Math.max(0, deadlineAt - (now + serverOffset)) : null;
}

function Timer({ deadlineAt, serverNow, large = false }: { deadlineAt: number | null; serverNow: number; large?: boolean }) {
  const remaining = useRemainingTime(deadlineAt, serverNow);
  const urgent = remaining !== null && remaining <= 10_000;
  return <span className={`timer${large ? " timer--large" : ""}${urgent ? " timer--urgent" : ""}`} aria-label={deadlineAt ? `Temps restant : ${formatTime(remaining ?? 0)}` : "Chronomètre en attente"}>{remaining === null ? "--:--" : formatTime(remaining)}</span>;
}

function PhaseCountdown({ deadlineAt, serverNow, label }: { deadlineAt: number; serverNow: number; label: string }) {
  const remaining = useRemainingTime(deadlineAt, serverNow);
  const urgent = remaining !== null && remaining <= 10_000;
  return <div className={`phase-countdown${urgent ? " is-urgent" : ""}`} role="timer" aria-label={`${label} : ${formatTime(remaining ?? 0)}`}><span>{label}</span><strong>{formatTime(remaining ?? 0)}</strong></div>;
}

function Scoreboard({ snapshot, compact = false }: { snapshot: RoomSnapshot; compact?: boolean }) {
  const sorted = [...snapshot.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "fr"));
  return (
    <ol className={`scoreboard${compact ? " scoreboard--compact" : ""}`}>
      {sorted.map((player) => (
        <li key={player.id} className={snapshot.turn?.drawerId === player.id ? "is-drawer" : ""}>
          <span>{player.name}</span><strong>{player.score}</strong>
        </li>
      ))}
    </ol>
  );
}

function RoundProgress({ snapshot, compact = false }: { snapshot: RoomSnapshot; compact?: boolean }) {
  const currentRound = snapshot.turn?.round ?? 0;
  const complete = snapshot.phase === "finished" ? snapshot.settings.rounds : Math.max(0, currentRound - 1);
  return <ol className={`round-progress${compact ? " round-progress--compact" : ""}`} aria-label={`Progression : tour ${Math.min(currentRound || 1, snapshot.settings.rounds)} sur ${snapshot.settings.rounds}`}>
    {Array.from({ length: snapshot.settings.rounds }, (_, index) => {
      const round = index + 1;
      const state = round <= complete ? "is-complete" : round === currentRound ? "is-current" : "";
      return <li key={round} className={state}><span className="sr-only">Tour {round}{round <= complete ? " terminé" : round === currentRound ? " en cours" : " à venir"}</span></li>;
    })}
  </ol>;
}

function GameStatus({ snapshot }: { snapshot: RoomSnapshot }) {
  const turn = snapshot.turn;
  const countdown = snapshot.phase === "awaiting_ready" ? turn?.readyDeadlineAt ?? null : null;
  const countdownLabel = snapshot.canDraw ? "Prêt dans" : "Relève dans";
  const details = (() => {
    switch (snapshot.phase) {
      case "lobby": return { eyebrow: "Salle prête", title: "Ajoutez les joueurs, puis lancez la partie." };
      case "awaiting_ready": return { eyebrow: `Tour ${turn?.round ?? 0}/${snapshot.settings.rounds}`, title: snapshot.canDraw ? "C’est votre tour : préparez-vous à dessiner." : turn ? `${turn.drawerName} prend le crayon.` : "Choix du dessinateur…" };
      case "armed": return { eyebrow: `Tour ${turn?.round ?? 0}/${snapshot.settings.rounds}`, title: "Le mot est choisi. Le chrono démarre au premier trait." };
      case "drawing": return { eyebrow: `Tour ${turn?.round ?? 0}/${snapshot.settings.rounds}`, title: snapshot.canDraw ? "Dessinez : les autres joueurs devinent." : "À vous de deviner — le dessinateur arbitre." };
      case "revealing": return { eyebrow: "Réponse", title: "Le mot et les points viennent d’être révélés." };
      case "finished": return { eyebrow: "Résultat", title: "La partie est terminée." };
    }
  })();
  return <section key={`${turn?.id ?? "lobby"}-${snapshot.phase}`} className={`game-status game-status--${snapshot.phase}`} aria-live="polite"><div><p className="eyebrow">{details.eyebrow}</p><strong>{details.title}</strong></div>{countdown ? <PhaseCountdown deadlineAt={countdown} serverNow={snapshot.serverNow} label={countdownLabel} /> : <RoundProgress snapshot={snapshot} compact />}</section>;
}

function drawStroke(
  context: CanvasRenderingContext2D,
  stroke: Stroke,
  inverse: boolean,
  width: number,
  height: number,
): void {
  if (stroke.points.length === 0) return;
  context.save();
  context.strokeStyle = stroke.tool === "eraser" ? (inverse ? "#000000" : "#ffffff") : (inverse ? "#f8f4ff" : "#11152a");
  context.fillStyle = context.strokeStyle;
  context.lineWidth = stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  const first = stroke.points[0]!;
  if (stroke.points.length === 1) {
    context.arc(first.x * width, first.y * height, stroke.width / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.moveTo(first.x * width, first.y * height);
    for (let index = 1; index < stroke.points.length; index += 1) {
      const point = stroke.points[index]!;
      context.lineTo(point.x * width, point.y * height);
    }
    context.stroke();
  }
  context.restore();
}

interface PaintedStroke {
  id: string;
  tool: Tool;
  width: number;
  pointCount: number;
  complete: boolean;
}

export const describeStrokes = (strokes: Stroke[]): PaintedStroke[] => strokes.map((stroke) => ({
  id: stroke.id,
  tool: stroke.tool,
  width: stroke.width,
  pointCount: stroke.points.length,
  complete: stroke.complete,
}));

export const canAppendStrokes = (previous: PaintedStroke[], next: Stroke[]): boolean => previous.length <= next.length && previous.every((stroke, index) => {
  const candidate = next[index];
  return candidate?.id === stroke.id
    && candidate.tool === stroke.tool
    && candidate.width === stroke.width
    && candidate.points.length >= stroke.pointCount
    && (!stroke.complete || candidate.complete);
});

function DrawingCanvas({
  strokes,
  draft,
  inverse,
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  ariaLabel,
}: {
  strokes: Stroke[];
  draft?: Stroke | null;
  inverse: boolean;
  className?: string;
  onPointerDown?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  ariaLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const committedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintedRef = useRef<PaintedStroke[]>([]);
  const dimensionsRef = useRef({ width: 0, height: 0, scale: 0, inverse });
  const contentsRef = useRef({ strokes, draft, inverse });
  contentsRef.current = { strokes, draft, inverse };
  const paint = useCallback((): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.floor(bounds.width * scale));
    const pixelHeight = Math.max(1, Math.floor(bounds.height * scale));
    const contents = contentsRef.current;
    const dimensions = dimensionsRef.current;
    const resized = dimensions.width !== pixelWidth || dimensions.height !== pixelHeight || dimensions.scale !== scale;
    const needsReset = resized || dimensions.inverse !== contents.inverse || !canAppendStrokes(paintedRef.current, contents.strokes);
    if (resized) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    if (!committedCanvasRef.current) committedCanvasRef.current = document.createElement("canvas");
    const committedCanvas = committedCanvasRef.current;
    if (resized) {
      committedCanvas.width = pixelWidth;
      committedCanvas.height = pixelHeight;
    }
    const committedContext = committedCanvas.getContext("2d");
    const context = canvas.getContext("2d");
    if (!context || !committedContext) return;

    if (needsReset) {
      committedContext.setTransform(scale, 0, 0, scale, 0, 0);
      committedContext.fillStyle = contents.inverse ? "#000000" : "#ffffff";
      committedContext.fillRect(0, 0, bounds.width, bounds.height);
      for (const stroke of contents.strokes) drawStroke(committedContext, stroke, contents.inverse, bounds.width, bounds.height);
    } else {
      for (let index = 0; index < contents.strokes.length; index += 1) {
        const stroke = contents.strokes[index]!;
        const previous = paintedRef.current[index];
        if (!previous) {
          drawStroke(committedContext, stroke, contents.inverse, bounds.width, bounds.height);
          continue;
        }
        if (stroke.points.length > previous.pointCount) {
          const start = Math.max(0, previous.pointCount - 1);
          drawStroke(committedContext, { ...stroke, points: stroke.points.slice(start) }, contents.inverse, bounds.width, bounds.height);
        }
      }
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(committedCanvas, 0, 0);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    if (contents.draft) drawStroke(context, contents.draft, contents.inverse, bounds.width, bounds.height);
    paintedRef.current = describeStrokes(contents.strokes);
    dimensionsRef.current = { width: pixelWidth, height: pixelHeight, scale, inverse: contents.inverse };
  }, []);
  useEffect(() => {
    paint();
  }, [draft, inverse, paint, strokes]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [paint]);
  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

function DrawingBoard({ snapshot, send }: { snapshot: RoomSnapshot; send: (command: ClientCommand) => void }) {
  const [tool, setTool] = useState<Tool>("pen");
  const [width, setWidth] = useState(8);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [clearConfirmation, setClearConfirmation] = useState(false);
  const [menuOpen, setMenuOpen] = useState(true);
  const activeRef = useRef<Stroke | null>(null);
  const pendingRef = useRef<Point[]>([]);
  const startedRef = useRef(false);
  const lastFlushRef = useRef(0);
  const draftFrameRef = useRef<number | null>(null);
  const clearTimerRef = useRef<number | null>(null);
  const turn = snapshot.turn;

  const cancelClearConfirmation = (): void => {
    if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = null;
    setClearConfirmation(false);
  };

  useEffect(() => () => {
    if (draftFrameRef.current) window.cancelAnimationFrame(draftFrameRef.current);
    if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
  }, []);
  useEffect(() => {
    activeRef.current = null;
    pendingRef.current = [];
    startedRef.current = false;
    setDraft(null);
    cancelClearConfirmation();
  }, [turn?.id]);
  useEffect(() => {
    if (snapshot.phase === "armed") setMenuOpen(true);
  }, [snapshot.phase, turn?.id]);

  const queueDraftPaint = (): void => {
    if (draftFrameRef.current !== null) return;
    draftFrameRef.current = window.requestAnimationFrame(() => {
      draftFrameRef.current = null;
      const active = activeRef.current;
      setDraft(active ? { ...active, points: [...active.points] } : null);
    });
  };

  const pointFromCoordinates = (target: HTMLCanvasElement, clientX: number, clientY: number): Point => {
    const rect = target.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  };

  const appendPoint = (active: Stroke, point: Point): void => {
    const previous = active.points.at(-1)!;
    // Keeping only visually distinct samples reduces message volume on high-Hz
    // touch screens without making fine curves feel polygonal.
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0012) return;
    active.points.push(point);
  };

  const flush = (complete: boolean): void => {
    const active = activeRef.current;
    if (!active || !turn || pendingRef.current.length === 0) return;
    while (pendingRef.current.length > 0) {
      const points = pendingRef.current.splice(0, STROKE_CHUNK_SIZE);
      send({ type: "stroke", turnId: turn.id, stroke: { id: active.id, tool: active.tool, width: active.width, points, complete: complete && pendingRef.current.length === 0 } });
    }
    lastFlushRef.current = performance.now();
  };

  const down = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!snapshot.canDraw || !turn) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some embedded browsers expose Pointer Events without pointer capture.
    }
    const point = pointFromCoordinates(event.currentTarget, event.clientX, event.clientY);
    const pressure = event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5;
    const pressureWidth = tool === "pen" && event.pointerType === "pen"
      ? Math.max(2, Math.min(28, Math.round(width * (0.55 + pressure * 0.9))))
      : width;
    const active: Stroke = { id: crypto.randomUUID(), tool, width: pressureWidth, points: [point], complete: false };
    activeRef.current = active;
    pendingRef.current = [];
    startedRef.current = false;
    lastFlushRef.current = performance.now();
    setDraft({ ...active, points: [...active.points] });
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const active = activeRef.current;
    if (!active) return;
    const target = event.currentTarget;
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    for (const sample of samples) appendPoint(active, pointFromCoordinates(target, sample.clientX, sample.clientY));
    const point = active.points.at(-1)!;
    if (!startedRef.current) {
      const first = active.points[0]!;
        const hasMoved = Math.hypot(point.x - first.x, point.y - first.y) > 0.003;
      if (hasMoved) {
        startedRef.current = true;
        pendingRef.current = [...active.points];
        haptic(8);
      }
    } else {
      pendingRef.current.push(point);
    }
    queueDraftPaint();
    if (startedRef.current && performance.now() - lastFlushRef.current >= 80) flush(false);
  };

  const up = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const active = activeRef.current;
    if (!active) return;
    // A short tap is a legitimate drawing gesture: it creates a dot and, when
    // it is the first gesture, starts the authoritative game timer as well.
    if (!startedRef.current) {
      startedRef.current = true;
      pendingRef.current = [...active.points];
      haptic(8);
    } else if (pendingRef.current.length === 0) {
      pendingRef.current = [active.points.at(-1)!];
    }
    flush(true);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Releasing capture is optional when the browser never granted it.
    }
    activeRef.current = null;
    pendingRef.current = [];
    startedRef.current = false;
    if (draftFrameRef.current) window.cancelAnimationFrame(draftFrameRef.current);
    draftFrameRef.current = null;
    setDraft(null);
  };

  const clear = (): void => {
    if (!turn || turn.strokes.length === 0) return;
    if (clearConfirmation) {
      send({ type: "clear", turnId: turn.id });
      haptic([10, 25, 10]);
      cancelClearConfirmation();
      return;
    }
    setClearConfirmation(true);
    clearTimerRef.current = window.setTimeout(() => {
      clearTimerRef.current = null;
      setClearConfirmation(false);
    }, CLEAR_CONFIRMATION_MS);
  };

  return (
    <section className="drawing-board drawing-board--terminal">
      <div className={`drawing-menu${menuOpen ? " is-open" : ""}`}>
        <button type="button" className="drawing-menu__trigger" aria-expanded={menuOpen} aria-controls="drawing-menu-panel" onClick={() => setMenuOpen((open) => !open)}>
          <span className="drawing-menu__toggle" aria-hidden="true">☰</span>
          <span className="drawing-menu__label">Menu</span>
          <span className="drawing-menu__word"><small>Mot secret</small><strong>{snapshot.secretWord}</strong></span>
          <span className="drawing-menu__timer">{snapshot.phase === "armed" ? "Le chrono démarre au premier trait" : <Timer deadlineAt={turn?.deadlineAt ?? null} serverNow={snapshot.serverNow} />}</span>
        </button>
        <div id="drawing-menu-panel" className="drawing-menu__panel" hidden={!menuOpen}>
          <div className="drawing-tools" aria-label="Outils de dessin">
            <button type="button" className={tool === "pen" ? "selected" : ""} onClick={() => { setTool("pen"); haptic(6); }}>Crayon</button>
            <button type="button" className={tool === "eraser" ? "selected" : ""} onClick={() => { setTool("eraser"); haptic(6); }}>Gomme</button>
            <label>Épaisseur <input name="stroke-width" aria-label="Épaisseur du trait" type="range" min="2" max="28" value={width} onChange={(event) => setWidth(Number(event.target.value))} /><output>{width}px</output></label>
            <button type="button" disabled={!turn?.strokes.length} onClick={() => { if (turn) { haptic(6); send({ type: "undo", turnId: turn.id }); } }}>Annuler</button>
            <button type="button" onClick={() => { if (turn) { haptic(6); send({ type: "redo", turnId: turn.id }); } }}>Rétablir</button>
            <button type="button" disabled={!turn?.strokes.length} className={clearConfirmation ? "is-danger" : ""} onClick={clear}>{clearConfirmation ? "Confirmer l’effacement" : "Tout effacer"}</button>
          </div>
          <p className="drawing-feedback" aria-live="polite">{clearConfirmation ? "Appuyez à nouveau pour effacer le dessin." : `${turn?.strokes.length ?? 0} trait${(turn?.strokes.length ?? 0) > 1 ? "s" : ""} envoyé${(turn?.strokes.length ?? 0) > 1 ? "s" : ""} en direct.`}</p>
          {snapshot.phase === "drawing" && snapshot.canSelectWinner && turn ? <WinnerSelection snapshot={snapshot} send={send} /> : null}
        </div>
      </div>
      <DrawingCanvas
        strokes={turn?.strokes ?? []}
        draft={draft}
        inverse={false}
        className="drawing-canvas"
        ariaLabel="Zone de dessin tactile"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
      />
    </section>
  );
}

function TerminalScreen({ snapshot, send }: { snapshot: RoomSnapshot; send: (command: ClientCommand) => void }) {
  const isDrawer = snapshot.canDraw;
  const turn = snapshot.turn;
  if (isDrawer && ["armed", "drawing"].includes(snapshot.phase)) {
    return <main className="drawing-terminal-screen"><DrawingBoard snapshot={snapshot} send={send} /></main>;
  }
  return (
    <main className="role-screen player-screen">
      <RoomHeader snapshot={snapshot} label="Terminal de dessin" />
      <GameStatus snapshot={snapshot} />
      {snapshot.phase === "finished" ? <Finished snapshot={snapshot} /> : null}
      {snapshot.phase === "awaiting_ready" && !isDrawer && snapshot.canTakeDrawingTurn && turn ? (
        <section className="status-card"><p className="eyebrow">Tour {turn.round}/{snapshot.settings.rounds}</p><h1>{turn.drawerName} doit dessiner</h1><p>Donnez ce téléphone à {turn.drawerName}, puis démarrez son tour.</p><button className="button button--primary" onClick={() => send({ type: "take_drawing_turn", turnId: turn.id })}>Utiliser ce téléphone</button></section>
      ) : null}
      {snapshot.phase === "awaiting_ready" && !isDrawer && !snapshot.canTakeDrawingTurn ? (
        <section className="status-card"><p className="eyebrow">En attente</p><h1>{turn ? `${turn.drawerName} prépare son dessin` : "La partie se prépare"}</h1><p>Ce tour utilise déjà un autre téléphone.</p></section>
      ) : null}
      {snapshot.phase === "awaiting_ready" && isDrawer ? (
        <section className="status-card"><p className="eyebrow">C’est votre tour</p><h1>Prêt·e à dessiner ?</h1><p>Le mot sera affiché uniquement sur ce téléphone. Sans réponse, un autre joueur sera choisi dans <Timer deadlineAt={turn?.readyDeadlineAt ?? null} serverNow={snapshot.serverNow} />.</p><button className="button button--primary" onClick={() => turn && send({ type: "ready", turnId: turn.id })}>Je suis prêt·e</button></section>
      ) : null}
      {snapshot.phase === "revealing" ? <Reveal snapshot={snapshot} /> : null}
      <section className="terminal-mode-card"><div><strong>Ce terminal peut aussi projeter</strong><p>Activez le fond noir et les traits lumineux pour le plexiglas.</p></div><button disabled={isDrawer} onClick={() => send({ type: "set_display_mode", displayMode: "projection" })}>Passer en mode projecteur</button>{isDrawer ? <small>Le terminal du dessinateur reste disponible jusqu’à la fin du tour.</small> : null}</section>
      <Scoreboard snapshot={snapshot} />
    </main>
  );
}

function WinnerSelection({ snapshot, send }: { snapshot: RoomSnapshot; send: (command: ClientCommand) => void }) {
  const turn = snapshot.turn;
  const [selectedWinnerId, setSelectedWinnerId] = useState<string | null>(null);
  const candidates = snapshot.players.filter((player) => player.id !== turn?.drawerId);
  useEffect(() => setSelectedWinnerId(null), [turn?.id]);
  if (!turn) return null;
  const selectedWinner = candidates.find((player) => player.id === selectedWinnerId) ?? null;
  const chooseWinner = (): void => {
    if (!selectedWinner) return;
    haptic([12, 35, 18]);
    send({ type: "select_winner", turnId: turn.id, playerId: selectedWinner.id });
  };
  const chooseNobody = (): void => {
    haptic(10);
    send({ type: "no_winner", turnId: turn.id });
  };
  return <section className="resolution" aria-labelledby="winner-selection-title"><div><p className="eyebrow">Validation du dessinateur</p><h2 id="winner-selection-title">Qui a trouvé ?</h2><p>Sélectionnez un joueur, puis validez son point.</p></div>{candidates.length > 0 ? <div className="winner-grid" role="group" aria-label="Joueur gagnant">{candidates.map((player) => <button key={player.id} type="button" className={`winner-button${selectedWinnerId === player.id ? " is-selected" : ""}`} aria-pressed={selectedWinnerId === player.id} onClick={() => { setSelectedWinnerId(player.id); haptic(8); }}><span className="winner-button__name">{player.name}</span><span className="winner-button__point">+1</span></button>)}</div> : <p className="resolution-empty">Vous êtes seul·e dans cette partie : il n’y a pas de joueur à départager.</p>}<div className="resolution-actions"><button type="button" className="button button--primary" disabled={!selectedWinner} onClick={chooseWinner}>{selectedWinner ? `Valider le point de ${selectedWinner.name}` : "Choisissez le gagnant"}</button><button type="button" className="no-winner-button" onClick={chooseNobody}>Personne n’a trouvé</button></div></section>;
}

function ToggleList<T extends string>({
  values, selected, toggle, label,
}: {
  values: readonly T[];
  selected: T[];
  toggle: (value: T) => void;
  label: (value: T) => string;
}) {
  return <div className="toggle-list">{values.map((value) => <button key={value} type="button" className={selected.includes(value) ? "selected" : ""} onClick={() => toggle(value)}>{label(value)}</button>)}</div>;
}

function ControllerScreen({ snapshot, send }: { snapshot: RoomSnapshot; send: (command: ClientCommand) => void }) {
  const [settings, setSettings] = useState<Settings>(snapshot.settings);
  const [playerName, setPlayerName] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  useEffect(() => {
    if (snapshot.phase === "lobby") setSettings(snapshot.settings);
  }, [snapshot.phase, snapshot.settings]);
  useEffect(() => {
    if (!copyFeedback) return undefined;
    const timer = window.setTimeout(() => setCopyFeedback(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [copyFeedback]);
  const toggleDifficulty = (value: Difficulty): void => {
    setSettings((previous) => {
      const list = previous.difficulties;
      const next = list.includes(value) ? list.filter((candidate) => candidate !== value) : [...list, value];
      return { ...previous, difficulties: next };
    });
  };
  const joinUrl = `${window.location.origin}/?join=${snapshot.code}`;
  const copyJoinLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      haptic(8);
      setCopyFeedback("Lien direct copié !");
    } catch {
      setCopyFeedback("Copie indisponible : scannez le QR code ou saisissez le code.");
    }
  };
  return (
    <main className="role-screen controller-screen">
      <RoomHeader snapshot={snapshot} label="Préparation" />
      <GameStatus snapshot={snapshot} />
      <section className="join-card">
        <div><p className="eyebrow">Salle</p><h1>{snapshot.code}</h1><p>Le lien et le QR code ouvrent directement cette salle sur les autres téléphones.</p><button className="link-button" type="button" onClick={() => void copyJoinLink()}>Copier le lien direct</button>{copyFeedback ? <p className="copy-feedback" role="status">{copyFeedback}</p> : null}</div>
        <Suspense fallback={<div className="qr-placeholder" aria-label="Génération du QR code" />}><RoomQrCode value={joinUrl} size={136} bgColor="#ffffff" fgColor="#101326" includeMargin /></Suspense>
      </section>
      <section className="settings-card">
        <h2>Joueurs</h2>
        <form className="button-row" onSubmit={(event) => { event.preventDefault(); if (!playerName.trim()) return; send({ type: "add_player", name: playerName }); setPlayerName(""); }}><label>Nom du joueur<input name="player-name" value={playerName} placeholder="ex. Lila" maxLength={24} onChange={(event) => setPlayerName(event.target.value)} /></label><button type="submit" disabled={playerName.trim().length < 2 || snapshot.players.length >= 12}>Ajouter</button></form>
        <Participants snapshot={snapshot} />
        <h2>Réglages de la partie</h2>
        <label>Durée <select name="duration" value={settings.durationSeconds} onChange={(event) => setSettings({ ...settings, durationSeconds: Number(event.target.value) as Settings["durationSeconds"] })}>{DURATIONS.map((duration) => <option key={duration} value={duration}>{duration} secondes</option>)}</select></label>
        <label>Nombre de manches <select name="rounds" value={settings.rounds} onChange={(event) => setSettings({ ...settings, rounds: Number(event.target.value) as Settings["rounds"] })}>{ROUND_COUNTS.map((rounds) => <option key={rounds} value={rounds}>{rounds} manches</option>)}</select></label>
        <h3>Difficulté</h3>
        <ToggleList values={DIFFICULTIES} selected={settings.difficulties} toggle={toggleDifficulty} label={(value) => value[0]!.toUpperCase() + value.slice(1)} />
        <div className="button-row"><button className="button button--primary" disabled={snapshot.players.length < 1 || settings.difficulties.length === 0} onClick={() => { send({ type: "configure", settings }); send({ type: "start_game" }); }}>Lancer avec ces réglages</button></div>
      </section>
    </main>
  );
}

function Participants({ snapshot }: { snapshot: RoomSnapshot }) {
  return <section className="participants"><h2>Joueurs inscrits ({snapshot.players.length}/12)</h2><Scoreboard snapshot={snapshot} /></section>;
}

function Reveal({ snapshot }: { snapshot: RoomSnapshot }) {
  const winner = snapshot.players.find((player) => player.id === snapshot.turn?.winnerId);
  return <section className={`reveal-card${winner ? " reveal-card--success" : ""}`} aria-live="assertive"><Celebration /><p className="eyebrow">La réponse était</p><h1>{snapshot.turn?.revealedWord}</h1><p>{winner ? <><strong>Bravo {winner.name} !</strong> +1 point pour lui et pour le dessinateur.</> : "Personne n’a trouvé : le prochain dessinateur a été tiré au sort."}</p></section>;
}

function Finished({ snapshot }: { snapshot: RoomSnapshot }) {
  const winners = snapshot.players.filter((player) => snapshot.finishedWinnerIds.includes(player.id));
  return <section className="finished-card" aria-live="assertive"><Celebration /><p className="eyebrow">Partie terminée</p><h1>{winners.map((player) => player.name).join(" et ")}</h1><p>{winners.length > 1 ? "sont ex æquo !" : "remporte la partie !"}</p><Scoreboard snapshot={snapshot} /></section>;
}

function Celebration() {
  return <div className="celebration" aria-hidden="true"><span>✦</span><span>✧</span><span>✦</span><span>✧</span><span>✦</span></div>;
}

function ProjectionCue({ snapshot }: { snapshot: RoomSnapshot }) {
  const turn = snapshot.turn;
  const content = (() => {
    if (snapshot.phase === "lobby") return { title: "Salle en préparation", detail: "Ajoutez les joueurs pour commencer." };
    if (snapshot.phase === "awaiting_ready") return { title: "À vos crayons", detail: turn ? `${turn.drawerName} prend le relais.` : "Choix du dessinateur…", deadlineAt: turn?.readyDeadlineAt ?? null, deadlineLabel: "Relève" };
    if (snapshot.phase === "armed") return { title: "Le mot est choisi", detail: "Le chronomètre commence au premier trait.", deadlineAt: turn?.armedDeadlineAt ?? null, deadlineLabel: "Commencez" };
    if (snapshot.phase === "revealing") return { title: "La réponse était", detail: turn?.revealedWord ?? "" };
    if (snapshot.phase === "finished") return { title: "Partie terminée", detail: "Score final affiché." };
    return null;
  })();
  if (!content) return null;
  return <div key={`${turn?.id ?? "lobby"}-${snapshot.phase}`} className="holo-cue"><strong>{content.title}</strong><span>{content.detail}</span>{content.deadlineAt && content.deadlineLabel ? <PhaseCountdown deadlineAt={content.deadlineAt} serverNow={snapshot.serverNow} label={content.deadlineLabel} /> : null}</div>;
}

function ProjectionScreen({ snapshot, onUseDrawingTerminal }: { snapshot: RoomSnapshot; onUseDrawingTerminal?: () => void }) {
  const [layout, setLayout] = useState<ProjectionLayout>("pyramid");
  const [calibration, setCalibration] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const presentationMode = immersive || nativeFullscreen;
  const preferredOrientation = (nextLayout: ProjectionLayout): "portrait" | "landscape" => nextLayout === "pyramid" ? "portrait" : "landscape";
  const lockOrientation = async (nextLayout: ProjectionLayout): Promise<void> => {
    try {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (orientation: string) => Promise<void> };
      await orientation.lock?.(preferredOrientation(nextLayout));
    } catch {
      // iOS Safari and some browsers do not permit programmatic orientation locks.
    }
  };
  const changeLayout = (nextLayout: ProjectionLayout): void => {
    setLayout(nextLayout);
    if (presentationMode) void lockOrientation(nextLayout);
  };
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    if ("wakeLock" in navigator) void (navigator as Navigator & { wakeLock: { request: (type: "screen") => Promise<WakeLockSentinel> } }).wakeLock.request("screen").then((lock) => { wakeLock = lock; }).catch(() => undefined);
    return () => void wakeLock?.release();
  }, []);
  useEffect(() => {
    const fullscreenDocument = document as Document & { webkitFullscreenElement?: Element | null };
    const syncFullscreen = (): void => {
      const active = Boolean(document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement);
      setNativeFullscreen(active);
      if (!active) setImmersive(false);
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("webkitfullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("webkitfullscreenchange", syncFullscreen);
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("projection-immersive", presentationMode);
    return () => document.documentElement.classList.remove("projection-immersive");
  }, [presentationMode]);
  const enterFullscreen = async (): Promise<void> => {
    // iOS Safari may not expose the Fullscreen API for documents. The CSS mode
    // still removes app chrome and uses the entire visible viewport in that case.
    setImmersive(true);
    const fullscreenElement = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    const requestFullscreen = fullscreenElement.requestFullscreen?.bind(fullscreenElement) ?? fullscreenElement.webkitRequestFullscreen?.bind(fullscreenElement);
    try {
      await requestFullscreen?.();
    } catch {
      // Keep the CSS presentation fallback active.
    }
    await lockOrientation(layout);
  };
  const exitFullscreen = async (): Promise<void> => {
    setImmersive(false);
    const fullscreenDocument = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
    const exit = document.exitFullscreen?.bind(document) ?? fullscreenDocument.webkitExitFullscreen?.bind(fullscreenDocument);
    try {
      await exit?.();
    } catch {
      // The fallback only changes local presentation styles.
    }
    try {
      screen.orientation?.unlock?.();
    } catch {
      // Orientation locks are optional and may not be exposed by the browser.
    }
  };
  // In a V support, each half of the display reflects into a lateral face.
  // The views therefore point away from the shared ridge (left: 90°, right: 270°).
  const copies = useMemo(() => layout === "pyramid" ? [0, 90, 180, 270] : layout === "vee" ? [90, 270] : [0], [layout]);
  const isDrawing = snapshot.phase === "drawing";
  return <main className={`projection-screen${presentationMode ? " projection-screen--immersive" : ""}`}>
    <header className={`projection-header${presentationMode ? " projection-header--hidden" : ""}`}><div><span className="brand">PICTIOFADY</span><span className="connection">Salle {snapshot.code}</span></div><div className="projection-controls">{onUseDrawingTerminal ? <button onClick={onUseDrawingTerminal}>Mode dessin</button> : null}<button onClick={() => setSettingsOpen(true)}>Réglages</button><button className="button button--primary" onClick={() => void enterFullscreen()}>Plein écran</button></div></header>
    <section className={`projection-stage projection-stage--${layout}`}>
      {copies.map((rotation, index) => <div key={rotation} className={`projection-copy projection-copy--${rotation}`}>
        {calibration ? <CalibrationMark number={index + 1} /> : <>{!isDrawing ? <><div className="holo-hud"><span>Tour {snapshot.turn?.round ?? 0}/{snapshot.settings.rounds}</span><Timer deadlineAt={snapshot.turn?.deadlineAt ?? null} serverNow={snapshot.serverNow} /><span>{snapshot.turn?.revealedWord ?? ""}</span></div><ProjectionCue snapshot={snapshot} /><div className="holo-scores"><Scoreboard snapshot={snapshot} compact /></div></> : null}<DrawingCanvas strokes={snapshot.turn?.strokes ?? []} inverse className="hologram-canvas" ariaLabel="Projection du dessin en cours" /></>}
      </div>)}
    </section>
    <p className="projection-help">Placez le plexiglas au centre de la mire. Le fond noir et les traits lumineux sont optimisés pour la réflexion.</p>
    {layout === "vee" ? <p className="projection-orientation-notice">Pour le support V, tournez le téléphone à l’horizontale.</p> : null}
    {presentationMode ? <div className="projection-presentation-actions">{onUseDrawingTerminal ? <button aria-label="Passer en mode dessin" onClick={onUseDrawingTerminal}>Dessin</button> : null}<button aria-label="Ouvrir les réglages de projection" onClick={() => setSettingsOpen(true)}>Réglages</button><button aria-label="Quitter le plein écran" onClick={() => void exitFullscreen()}>Quitter</button></div> : null}
    {settingsOpen ? <ProjectionSettings snapshot={snapshot} layout={layout} calibration={calibration} onLayoutChange={changeLayout} onCalibrationChange={setCalibration} onUseDrawingTerminal={onUseDrawingTerminal} onClose={() => setSettingsOpen(false)} /> : null}
  </main>;
}

function ProjectionSettings({ snapshot, layout, calibration, onLayoutChange, onCalibrationChange, onUseDrawingTerminal, onClose }: { snapshot: RoomSnapshot; layout: ProjectionLayout; calibration: boolean; onLayoutChange: (layout: ProjectionLayout) => void; onCalibrationChange: (value: boolean) => void; onUseDrawingTerminal?: () => void; onClose: () => void }) {
  return <section className="projection-settings-backdrop" role="dialog" aria-modal="true" aria-labelledby="projection-settings-title">
    <div className="projection-settings-panel">
      <div className="projection-settings-heading"><div><p className="eyebrow">Projection</p><h1 id="projection-settings-title">Réglages</h1></div><button className="projection-settings-close" aria-label="Fermer les réglages" onClick={onClose}>×</button></div>
      <label>Support <select name="projection-layout" value={layout} onChange={(event) => onLayoutChange(event.target.value as ProjectionLayout)}><option value="pyramid">Pyramide — 4 faces</option><option value="vee">Plexi en V — 2 faces</option><option value="single">Plaque — 1 face</option></select></label>
      <p className="projection-orientation-help">{layout === "pyramid" ? "La pyramide utilise un carré : le mode portrait est privilégié." : "Ce support utilise le mode paysage afin d’occuper toute la hauteur de l’écran."}</p>
      <button onClick={() => onCalibrationChange(!calibration)}>{calibration ? "Voir le jeu" : "Afficher la mire"}</button>
      <section className="projection-game-summary" aria-label="Réglages de la partie">
        <h2>Partie en cours</h2>
        <dl><div><dt>Durée</dt><dd>{snapshot.settings.durationSeconds} secondes</dd></div><div><dt>Tours</dt><dd>{snapshot.settings.rounds}</dd></div><div><dt>Difficulté</dt><dd>{snapshot.settings.difficulties.join(", ")}</dd></div></dl>
        <p>Les règles sont verrouillées après le lancement afin de préserver le tour en cours.</p>
      </section>
      {onUseDrawingTerminal ? <button onClick={onUseDrawingTerminal}>Revenir au mode dessin</button> : null}
      <button className="button button--primary" onClick={onClose}>Reprendre la projection</button>
    </div>
  </section>;
}

function CalibrationMark({ number }: { number: number }) {
  return <div className="calibration-mark"><span className="calibration-corner calibration-corner--one">↖</span><span className="calibration-corner calibration-corner--two">↗</span><span className="calibration-corner calibration-corner--three">↘</span><span className="calibration-corner calibration-corner--four">↙</span><strong>{number}</strong><small>PICTIOFADY</small></div>;
}

function RoomHeader({ snapshot, label }: { snapshot: RoomSnapshot; label: string }) {
  return <header className="room-header"><div><span className="brand">PICTIOFADY</span><span className="room-label">{label}</span></div><div><span className="room-code">{snapshot.code}</span><span className="status-dot">en direct</span></div></header>;
}

function PwaInstallCard({ pwa }: { pwa: PwaControls }) {
  if (pwa.isInstalled || (!pwa.canInstall && !pwa.isAppleMobile)) return null;
  return <aside className="pwa-install-card" aria-label="Installer PictioFady">
    <div><span className="pwa-install-card__icon" aria-hidden="true">◇</span><p className="eyebrow">Mode application</p><strong>Gardez PictioFady à portée de main.</strong><p>{pwa.isAppleMobile && !pwa.canInstall ? "Sur iPhone ou iPad : touchez Partager, puis « Sur l’écran d’accueil »." : "Installez l’application pour ouvrir plus vite la projection et profiter du plein écran."}</p></div>
    {pwa.canInstall ? <button type="button" className="button button--primary" onClick={() => void pwa.install()}>Installer</button> : null}
  </aside>;
}

function PwaUpdateNotice({ pwa }: { pwa: PwaControls }) {
  if (!pwa.updateAvailable) return null;
  return <aside className="pwa-update" role="status"><span>Une amélioration est prête.</span><button type="button" onClick={pwa.applyUpdate}>Actualiser</button></aside>;
}

function JoinCodeInput({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (code: string) => void }) {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const focus = (index: number): void => {
    window.requestAnimationFrame(() => {
      const input = inputRefs.current[Math.max(0, Math.min(ROOM_CODE_LENGTH - 1, index))];
      input?.focus();
      input?.select();
    });
  };
  const replaceFrom = (requestedIndex: number, rawValue: string): void => {
    const incoming = normaliseCode(rawValue);
    if (!incoming) return;
    const index = Math.min(requestedIndex, value.length);
    const next = `${value.slice(0, index)}${incoming}${value.slice(index + incoming.length)}`.slice(0, ROOM_CODE_LENGTH);
    onChange(next);
    focus(Math.min(index + incoming.length, ROOM_CODE_LENGTH - 1));
  };
  const removeAt = (index: number): void => {
    if (index < value.length) {
      onChange(`${value.slice(0, index)}${value.slice(index + 1)}`);
      focus(index);
      return;
    }
    if (index > 0) {
      onChange(`${value.slice(0, index - 1)}${value.slice(index)}`);
      focus(index - 1);
    }
  };
  return <fieldset className="code-entry" disabled={disabled}>
    <legend>Code de salle</legend>
    <div className="code-entry__boxes" onPaste={(event) => {
      event.preventDefault();
      const targetIndex = Number((event.target as HTMLInputElement).dataset.index ?? 0);
      replaceFrom(targetIndex, event.clipboardData.getData("text"));
    }}>
      {Array.from({ length: ROOM_CODE_LENGTH }, (_, index) => <input
        key={index}
        ref={(element) => { inputRefs.current[index] = element; }}
        data-index={index}
        name={`room-code-${index + 1}`}
        value={value[index] ?? ""}
        maxLength={1}
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={`Caractère ${index + 1} du code de salle`}
        onFocus={(event) => {
          if (index > value.length) focus(value.length);
          else event.currentTarget.select();
        }}
        onChange={(event) => replaceFrom(index, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            removeAt(index);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            focus(index - 1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            focus(index + 1);
          }
        }}
      />)}
    </div>
  </fieldset>;
}

function Home({ onSession, pwa }: { onSession: (session: StoredSession) => void; pwa: PwaControls }) {
  const [code, setCode] = useState(directJoinCode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attemptedCodeRef = useRef<string | null>(null);
  const create = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const result = await request<StoredSession>("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      onSession(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Création impossible."); } finally { setBusy(false); }
  };
  const join = useCallback(async (roomCode: string): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const payload: JoinRoomRequest = { role: "terminal" };
      const result = await request<StoredSession>(`/api/rooms/${roomCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      clearDirectJoinUrl();
      onSession(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Connexion impossible."); } finally { setBusy(false); }
  }, [onSession]);
  useEffect(() => {
    if (code.length !== ROOM_CODE_LENGTH) {
      attemptedCodeRef.current = null;
      return;
    }
    if (attemptedCodeRef.current === code) return;
    attemptedCodeRef.current = code;
    void join(code);
  }, [code, join]);
  const updateCode = (nextCode: string): void => {
    setError(null);
    setCode(nextCode);
  };
  return <main className="home"><section className="hero"><span className="brand">PICTIOFADY</span><p className="eyebrow">Nouvelle partie</p><h1>Créer une partie</h1><p>Préparez les joueurs, choisissez la difficulté, le nombre de manches et leur durée.</p><button className="button button--primary" disabled={busy} onClick={() => void create()}>Créer la salle <span aria-hidden="true">→</span></button></section><section className="join-panel"><span className="brand">PICTIOFADY</span><p className="eyebrow">Code reçu</p><h2>Rejoindre une partie</h2><div className="join-code"><JoinCodeInput value={code} disabled={busy} onChange={updateCode} /><p className="subtle">La connexion se lance automatiquement dès que les 6 caractères sont saisis.</p>{busy ? <p className="join-code__status" role="status">Connexion à la salle…</p> : null}</div>{error ? <p className="error-message" role="alert">{error}</p> : null}<PwaInstallCard pwa={pwa} /></section></main>;
}

export function App() {
  const [session, setSession] = useState<StoredSession | null>(() => directJoinCode().length === ROOM_CODE_LENGTH ? null : loadSession());
  const pwa = usePwaLifecycle();
  const { snapshot, connectionError, connected, send } = useRoomSocket(session);
  const adoptSession = (next: StoredSession): void => { saveSession(next); setSession(next); };
  const leave = (): void => { saveSession(null); setSession(null); };
  if (!session) return <><PwaUpdateNotice pwa={pwa} /><Home onSession={adoptSession} pwa={pwa} /></>;
  if (!snapshot) return <><PwaUpdateNotice pwa={pwa} /><main className="loading"><span className="brand">PICTIOFADY</span><h1>Connexion à la salle {session.code}</h1><p>{connectionError ?? "Synchronisation de la partie…"}</p><button onClick={leave}>Quitter</button></main></>;
  return <><PwaUpdateNotice pwa={pwa} /><div className={`connection-banner${connected ? "" : " is-offline"}`} role="status">{connected ? "Synchronisé" : connectionError ?? "Reconnexion…"}</div>{connected && connectionError ? <p className="connection-message" role="alert">{connectionError}</p> : null}{session.role === "controller" ? snapshot.phase === "lobby" ? <ControllerScreen snapshot={snapshot} send={send} /> : <ProjectionScreen snapshot={snapshot} /> : null}{session.role === "terminal" ? snapshot.displayMode === "projection" ? <ProjectionScreen snapshot={snapshot} onUseDrawingTerminal={() => send({ type: "set_display_mode", displayMode: "drawing" })} /> : <TerminalScreen snapshot={snapshot} send={send} /> : null}<button className="leave-button" onClick={leave}>Quitter la salle</button></>;
}
