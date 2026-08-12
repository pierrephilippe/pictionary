import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DIFFICULTIES,
  DURATIONS,
  ROUND_COUNTS,
  THEMES,
  type Difficulty,
  type Point,
  type ProjectionLayout,
  type RoomSnapshot,
  type Settings,
  type Stroke,
  type Theme,
  type Tool,
} from "../domain/types";
import type { ClientCommand, JoinRoomRequest } from "../shared/protocol";

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

const ACTIVE_SESSION_KEY = "prisme.active-session";

const request = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, init);
  const data = await response.json() as T & ApiError;
  if (!response.ok) throw new Error(data.error ?? "La requête a échoué.");
  return data;
};

const saveSession = (session: StoredSession | null): void => {
  if (!session) {
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    return;
  }
  localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
};

const loadSession = (): StoredSession | null => {
  try {
    const value = localStorage.getItem(ACTIVE_SESSION_KEY);
    const session = value ? JSON.parse(value) as StoredSession : null;
    return session?.role === "controller" || session?.role === "terminal" ? session : null;
  } catch {
    return null;
  }
};

const normaliseCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

const socketUrl = (code: string, ticket: string): string => {
  const url = new URL(`/api/rooms/${code}/socket`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
};

function useRoomSocket(session: StoredSession | null) {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setSnapshot(null);
    setConnectionError(null);
    setConnected(false);
    if (!session) return undefined;
    let disposed = false;
    let socket: WebSocket | null = null;

    const connect = async (): Promise<void> => {
      try {
        const ticket = await request<{ ticket: string }>(`/api/rooms/${session.code}/ticket`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.token}` },
        });
        if (disposed) return;
        socket = new WebSocket(socketUrl(session.code, ticket.ticket));
        socketRef.current = socket;
        socket.onopen = () => {
          setConnected(true);
          setConnectionError(null);
        };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data)) as ServerMessage;
            if (message.type === "snapshot") setSnapshot(message.snapshot);
            if (message.type === "stroke_delta") {
              setSnapshot((previous) => mergeStrokeDelta(previous, message.round, message.stroke));
            }
            if (message.type === "error") setConnectionError(message.message ?? "Commande refusée.");
          } catch {
            setConnectionError("Réponse serveur illisible.");
          }
        };
        socket.onclose = () => {
          setConnected(false);
          if (!disposed) reconnectRef.current = window.setTimeout(() => void connect(), 1_000);
        };
        socket.onerror = () => setConnectionError("La connexion temps réel a rencontré un problème.");
      } catch (error) {
        if (!disposed) {
          setConnected(false);
          setConnectionError(error instanceof Error ? error.message : "Connexion impossible.");
          reconnectRef.current = window.setTimeout(() => void connect(), 1_500);
        }
      }
    };
    void connect();
    return () => {
      disposed = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
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
  const strokes = snapshot.turn.strokes.map((candidate) => ({ ...candidate, points: [...candidate.points] }));
  const existing = strokes.find((candidate) => candidate.id === stroke.id);
  if (existing) {
    if (existing.complete) return snapshot;
    existing.points.push(...stroke.points);
    existing.complete ||= stroke.complete;
  } else {
    strokes.push({ ...stroke, points: [...stroke.points] });
  }
  return { ...snapshot, turn: { ...snapshot.turn, strokes } };
};

const formatTime = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

function Timer({ deadlineAt, serverNow, large = false }: { deadlineAt: number | null; serverNow: number; large?: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [serverOffset, setServerOffset] = useState(() => serverNow - Date.now());
  useEffect(() => {
    setNow(Date.now());
    setServerOffset(serverNow - Date.now());
  }, [serverNow]);
  useEffect(() => {
    if (!deadlineAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [deadlineAt]);
  return <span className={`timer${large ? " timer--large" : ""}`}>{deadlineAt ? formatTime(deadlineAt - (now + serverOffset)) : "--:--"}</span>;
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
    for (const point of stroke.points.slice(1)) context.lineTo(point.x * width, point.y * height);
    context.stroke();
  }
  context.restore();
}

function DrawingCanvas({
  strokes,
  draft,
  inverse,
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  strokes: Stroke[];
  draft?: Stroke | null;
  inverse: boolean;
  className?: string;
  onPointerDown?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const paint = (): void => {
      const bounds = canvas.getBoundingClientRect();
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.max(1, Math.floor(bounds.width * scale));
      const pixelHeight = Math.max(1, Math.floor(bounds.height * scale));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.fillStyle = inverse ? "#000000" : "#ffffff";
      context.fillRect(0, 0, bounds.width, bounds.height);
      for (const stroke of strokes) drawStroke(context, stroke, inverse, bounds.width, bounds.height);
      if (draft) drawStroke(context, draft, inverse, bounds.width, bounds.height);
    };
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draft, inverse, strokes]);
  return (
    <canvas
      ref={canvasRef}
      className={className}
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
  const activeRef = useRef<Stroke | null>(null);
  const pendingRef = useRef<Point[]>([]);
  const startedRef = useRef(false);
  const lastFlushRef = useRef(0);
  const turn = snapshot.turn;

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const flush = (complete: boolean): void => {
    const active = activeRef.current;
    if (!active || !turn || pendingRef.current.length === 0) return;
    const points = pendingRef.current.splice(0);
    send({ type: "stroke", turnId: turn.id, stroke: { id: active.id, tool: active.tool, width: active.width, points, complete } });
    lastFlushRef.current = performance.now();
  };

  const down = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!snapshot.canDraw || !turn) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    const active: Stroke = { id: crypto.randomUUID(), tool, width, points: [point], complete: false };
    activeRef.current = active;
    pendingRef.current = [];
    startedRef.current = false;
    lastFlushRef.current = performance.now();
    setDraft(active);
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const active = activeRef.current;
    if (!active) return;
    const point = pointFromEvent(event);
    active.points = [...active.points, point];
    if (!startedRef.current) {
      const first = active.points[0]!;
      const hasMoved = Math.hypot(point.x - first.x, point.y - first.y) > 0.003;
      if (hasMoved) {
        startedRef.current = true;
        pendingRef.current = [...active.points];
      }
    } else {
      pendingRef.current.push(point);
    }
    setDraft({ ...active, points: [...active.points] });
    if (startedRef.current && performance.now() - lastFlushRef.current >= 80) flush(false);
  };

  const up = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!activeRef.current) return;
    if (startedRef.current && pendingRef.current.length === 0) {
      pendingRef.current = [activeRef.current.points.at(-1)!];
    }
    if (startedRef.current) flush(true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    activeRef.current = null;
    pendingRef.current = [];
    startedRef.current = false;
    setDraft(null);
  };

  return (
    <section className="drawing-board">
      <div className="drawing-tools" aria-label="Outils de dessin">
        <button type="button" className={tool === "pen" ? "selected" : ""} onClick={() => setTool("pen")}>Crayon</button>
        <button type="button" className={tool === "eraser" ? "selected" : ""} onClick={() => setTool("eraser")}>Gomme</button>
        <label>Épaisseur <input aria-label="Épaisseur du trait" type="range" min="2" max="28" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
        <button type="button" onClick={() => turn && send({ type: "undo", turnId: turn.id })}>Annuler</button>
        <button type="button" onClick={() => turn && send({ type: "redo", turnId: turn.id })}>Rétablir</button>
        <button type="button" onClick={() => turn && send({ type: "clear", turnId: turn.id })}>Tout effacer</button>
      </div>
      <DrawingCanvas
        strokes={turn?.strokes ?? []}
        draft={draft}
        inverse={false}
        className="drawing-canvas"
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
  return (
    <main className="role-screen player-screen">
      <RoomHeader snapshot={snapshot} label="Terminal de dessin" />
      {snapshot.phase === "finished" ? <Finished snapshot={snapshot} /> : null}
      {snapshot.phase === "awaiting_ready" && snapshot.canTakeDrawingTurn && turn ? (
        <section className="status-card"><p className="eyebrow">Tour {turn.round}/{snapshot.settings.rounds}</p><h1>{turn.drawerName} doit dessiner</h1><p>Donnez ce téléphone à {turn.drawerName}, puis démarrez son tour.</p><button className="button button--primary" onClick={() => send({ type: "take_drawing_turn", turnId: turn.id })}>Utiliser ce téléphone</button></section>
      ) : null}
      {snapshot.phase === "awaiting_ready" && !isDrawer && !snapshot.canTakeDrawingTurn ? (
        <section className="status-card"><p className="eyebrow">En attente</p><h1>{turn ? `${turn.drawerName} prépare son dessin` : "La partie se prépare"}</h1><p>Ce tour utilise déjà un autre téléphone.</p></section>
      ) : null}
      {snapshot.phase === "awaiting_ready" && isDrawer ? (
        <section className="status-card"><p className="eyebrow">C’est votre tour</p><h1>Prêt·e à dessiner ?</h1><p>Le mot sera affiché uniquement sur ce téléphone. Sans réponse, un autre joueur sera choisi dans <Timer deadlineAt={turn?.readyDeadlineAt ?? null} serverNow={snapshot.serverNow} />.</p><button className="button button--primary" onClick={() => turn && send({ type: "ready", turnId: turn.id })}>Je suis prêt·e</button></section>
      ) : null}
      {["armed", "drawing"].includes(snapshot.phase) && isDrawer ? (
        <>
          <section className="secret-word"><span>Votre mot secret</span><strong>{snapshot.secretWord}</strong>{snapshot.phase === "armed" ? <p>Le chronomètre démarre à votre premier trait. Commencez avant <Timer deadlineAt={turn?.armedDeadlineAt ?? null} serverNow={snapshot.serverNow} />.</p> : <Timer deadlineAt={turn?.deadlineAt ?? null} serverNow={snapshot.serverNow} large />}</section>
          <DrawingBoard snapshot={snapshot} send={send} />
        </>
      ) : null}
      {snapshot.phase === "drawing" && snapshot.canSelectWinner && turn ? <WinnerSelection snapshot={snapshot} send={send} /> : null}
      {snapshot.phase === "revealing" ? <Reveal snapshot={snapshot} /> : null}
      <Scoreboard snapshot={snapshot} />
    </main>
  );
}

function WinnerSelection({ snapshot, send }: { snapshot: RoomSnapshot; send: (command: ClientCommand) => void }) {
  const turn = snapshot.turn;
  if (!turn) return null;
  return <section className="resolution"><h2>Qui a trouvé ?</h2><p>Le dessinateur valide la première bonne réponse entendue.</p><div className="button-row">{snapshot.players.filter((player) => player.id !== turn.drawerId).map((player) => <button key={player.id} onClick={() => send({ type: "select_winner", turnId: turn.id, playerId: player.id })}>{player.name}</button>)}<button onClick={() => send({ type: "no_winner", turnId: turn.id })}>Personne n’a trouvé</button></div></section>;
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
  useEffect(() => {
    if (snapshot.phase === "lobby") setSettings(snapshot.settings);
  }, [snapshot.phase, snapshot.settings]);
  const toggle = <T extends string,>(key: "themes" | "difficulties", value: T): void => {
    setSettings((previous) => {
      const list = previous[key] as T[];
      const next = list.includes(value) ? list.filter((candidate) => candidate !== value) : [...list, value];
      return { ...previous, [key]: next } as Settings;
    });
  };
  const joinUrl = `${window.location.origin}?join=${snapshot.code}`;
  return (
    <main className="role-screen controller-screen">
      <RoomHeader snapshot={snapshot} label="Préparation" />
      <section className="join-card">
        <div><p className="eyebrow">Salle</p><h1>{snapshot.code}</h1><p>Scannez le QR code depuis les téléphones terminaux. Cet écran devient la projection au lancement.</p></div>
        <QRCodeSVG value={joinUrl} size={136} bgColor="#ffffff" fgColor="#101326" includeMargin />
      </section>
      <section className="settings-card">
        <h2>Joueurs</h2>
        <form className="button-row" onSubmit={(event) => { event.preventDefault(); if (!playerName.trim()) return; send({ type: "add_player", name: playerName }); setPlayerName(""); }}><label>Nom du joueur<input value={playerName} placeholder="ex. Lila" maxLength={24} onChange={(event) => setPlayerName(event.target.value)} /></label><button type="submit" disabled={playerName.trim().length < 2 || snapshot.players.length >= 12}>Ajouter</button></form>
        <Participants snapshot={snapshot} />
        <h2>Réglages de la partie</h2>
        <label>Durée <select value={settings.durationSeconds} onChange={(event) => setSettings({ ...settings, durationSeconds: Number(event.target.value) as Settings["durationSeconds"] })}>{DURATIONS.map((duration) => <option key={duration} value={duration}>{duration} secondes</option>)}</select></label>
        <label>Nombre de tours <select value={settings.rounds} onChange={(event) => setSettings({ ...settings, rounds: Number(event.target.value) as Settings["rounds"] })}>{ROUND_COUNTS.map((rounds) => <option key={rounds} value={rounds}>{rounds} tours</option>)}</select></label>
        <h3>Thèmes</h3>
        <ToggleList values={THEMES} selected={settings.themes} toggle={(value) => toggle("themes", value)} label={(value) => ({ animaux: "Animaux", objets: "Objets", alimentation: "Alimentation", lieux: "Lieux", metiers: "Métiers" })[value]} />
        <h3>Difficulté</h3>
        <ToggleList values={DIFFICULTIES} selected={settings.difficulties} toggle={(value) => toggle("difficulties", value)} label={(value) => value[0]!.toUpperCase() + value.slice(1)} />
        <div className="button-row"><button onClick={() => send({ type: "configure", settings })}>Enregistrer</button><button className="button button--primary" disabled={snapshot.players.length < 1 || settings.themes.length === 0 || settings.difficulties.length === 0} onClick={() => { send({ type: "configure", settings }); send({ type: "start_game" }); }}>Lancer la partie</button></div>
      </section>
    </main>
  );
}

function Participants({ snapshot }: { snapshot: RoomSnapshot }) {
  return <section className="participants"><h2>Joueurs inscrits ({snapshot.players.length}/12)</h2><Scoreboard snapshot={snapshot} /></section>;
}

function Reveal({ snapshot }: { snapshot: RoomSnapshot }) {
  const winner = snapshot.players.find((player) => player.id === snapshot.turn?.winnerId);
  return <section className="reveal-card"><p className="eyebrow">La réponse était</p><h1>{snapshot.turn?.revealedWord}</h1><p>{winner ? `${winner.name} a trouvé : +1 point pour lui et pour le dessinateur.` : "Personne n’a trouvé : le prochain dessinateur a été tiré au sort."}</p></section>;
}

function Finished({ snapshot }: { snapshot: RoomSnapshot }) {
  const winners = snapshot.players.filter((player) => snapshot.finishedWinnerIds.includes(player.id));
  return <section className="finished-card"><p className="eyebrow">Partie terminée</p><h1>{winners.map((player) => player.name).join(" et ")}</h1><p>{winners.length > 1 ? "sont ex æquo !" : "remporte la partie !"}</p><Scoreboard snapshot={snapshot} /></section>;
}

function ProjectionScreen({ snapshot }: { snapshot: RoomSnapshot }) {
  const [layout, setLayout] = useState<ProjectionLayout>("pyramid");
  const [calibration, setCalibration] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const presentationMode = immersive || nativeFullscreen;
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
    try {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (orientation: string) => Promise<void> };
      await orientation.lock?.("landscape");
    } catch {
      // Orientation locking is not available on several mobile browsers.
    }
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
  };
  // In a V support, each half of the display reflects into a lateral face.
  // The views therefore point away from the shared ridge (left: 90°, right: 270°).
  const copies = layout === "pyramid" ? [0, 90, 180, 270] : layout === "vee" ? [90, 270] : [0];
  return <main className={`projection-screen${presentationMode ? " projection-screen--immersive" : ""}`}>
    <header className={`projection-header${presentationMode ? " projection-header--hidden" : ""}`}><div><span className="brand">PRISME</span><span className="connection">Salle {snapshot.code}</span></div><div className="projection-controls"><label>Support <select value={layout} onChange={(event) => setLayout(event.target.value as ProjectionLayout)}><option value="pyramid">Pyramide — 4 faces</option><option value="vee">Plexi en V — 2 faces</option><option value="single">Plaque — 1 face</option></select></label><button onClick={() => setCalibration((value) => !value)}>{calibration ? "Voir le jeu" : "Mire"}</button><button className="button button--primary" onClick={() => void enterFullscreen()}>Plein écran</button></div></header>
    <section className={`projection-stage projection-stage--${layout}`}>
      {copies.map((rotation, index) => <div key={rotation} className="projection-copy" style={{ "--rotation": `${rotation}deg` } as React.CSSProperties}>
        {calibration ? <CalibrationMark number={index + 1} /> : <><div className="holo-hud"><span>Tour {snapshot.turn?.round ?? 0}/{snapshot.settings.rounds}</span><Timer deadlineAt={snapshot.turn?.deadlineAt ?? null} serverNow={snapshot.serverNow} /><span>{snapshot.turn?.revealedWord ?? ""}</span></div><DrawingCanvas strokes={snapshot.turn?.strokes ?? []} inverse className="hologram-canvas" /><div className="holo-scores"><Scoreboard snapshot={snapshot} compact /></div></>}
      </div>)}
    </section>
    <p className="projection-help">Placez le plexiglas au centre de la mire. Le fond noir et les traits lumineux sont optimisés pour la réflexion.</p>
    {presentationMode ? <button className="projection-exit" onClick={() => void exitFullscreen()}>Quitter le plein écran</button> : null}
  </main>;
}

function CalibrationMark({ number }: { number: number }) {
  return <div className="calibration-mark"><span className="calibration-corner calibration-corner--one">↖</span><span className="calibration-corner calibration-corner--two">↗</span><span className="calibration-corner calibration-corner--three">↘</span><span className="calibration-corner calibration-corner--four">↙</span><strong>{number}</strong><small>PRISME</small></div>;
}

function RoomHeader({ snapshot, label }: { snapshot: RoomSnapshot; label: string }) {
  return <header className="room-header"><div><span className="brand">PRISME</span><span className="room-label">{label}</span></div><div><span className="room-code">{snapshot.code}</span><span className="status-dot">en direct</span></div></header>;
}

function Home({ onSession }: { onSession: (session: StoredSession) => void }) {
  const initialCode = normaliseCode(new URLSearchParams(window.location.search).get("join") ?? "");
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const result = await request<StoredSession>("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      onSession(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Création impossible."); } finally { setBusy(false); }
  };
  const join = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const payload: JoinRoomRequest = { role: "terminal" };
      const result = await request<StoredSession>(`/api/rooms/${normaliseCode(code)}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      onSession(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Connexion impossible."); } finally { setBusy(false); }
  };
  return <main className="home"><section className="hero"><span className="brand">PRISME</span><p className="eyebrow">Pictionary holographique</p><h1>Dessinez. Devinez.<br />Faites apparaître le jeu.</h1><p>Créez la partie sur le téléphone qui servira de projection. Le téléphone principal inscrit les joueurs, tandis que les autres téléphones sont des terminaux de dessin.</p><button className="button button--primary" disabled={busy} onClick={() => void create()}>Créer une partie</button></section><section className="join-panel"><p className="eyebrow">Rejoindre une partie</p><form onSubmit={join}><label>Code de salle<input value={code} placeholder="ABC123" maxLength={6} onChange={(event) => setCode(normaliseCode(event.target.value))} /></label><p className="subtle">Ce téléphone pourra être confié au dessinateur désigné à chaque tour.</p><button className="button button--primary" disabled={busy || code.length !== 6}>{busy ? "Connexion…" : "Rejoindre comme terminal"}</button></form>{error ? <p className="error-message">{error}</p> : null}</section></main>;
}

export function App() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());
  const { snapshot, connectionError, connected, send } = useRoomSocket(session);
  const adoptSession = (next: StoredSession): void => { saveSession(next); setSession(next); };
  const leave = (): void => { saveSession(null); setSession(null); };
  if (!session) return <Home onSession={adoptSession} />;
  if (!snapshot) return <main className="loading"><span className="brand">PRISME</span><h1>Connexion à la salle {session.code}</h1><p>{connectionError ?? "Synchronisation de la partie…"}</p><button onClick={leave}>Quitter</button></main>;
  return <><div className={`connection-banner${connected ? "" : " is-offline"}`}>{connected ? "Synchronisé" : connectionError ?? "Reconnexion…"}</div>{session.role === "controller" ? snapshot.phase === "lobby" ? <ControllerScreen snapshot={snapshot} send={send} /> : <ProjectionScreen snapshot={snapshot} /> : null}{session.role === "terminal" ? <TerminalScreen snapshot={snapshot} send={send} /> : null}<button className="leave-button" onClick={leave}>Quitter la salle</button></>;
}
