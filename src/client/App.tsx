import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  DIFFICULTIES,
  DURATIONS,
  ROUND_COUNTS,
  type Difficulty,
  type Point,
  type RoomSnapshot,
  type Settings,
  type Stroke,
  type Tool,
} from "../domain/types";
import type { ClientCommand, JoinRoomRequest } from "../shared/protocol";
import {
  clearDirectJoinUrl,
  directJoinCode,
  loadSession,
  normaliseRoomCode as normaliseCode,
  requestJson as request,
  ROOM_CODE_LENGTH,
  saveSession,
  type StoredSession,
} from "./session";
import { useRoomConnection } from "./useRoomConnection";
import { DrawingCanvas } from "./drawing/DrawingCanvas";
import { VEE_FACE_ROTATIONS } from "./projection";

const RoomQrCode = lazy(async () => {
  const module = await import("qrcode.react");
  return { default: module.QRCodeSVG };
});

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

const STROKE_CHUNK_SIZE = 96;
const CLEAR_CONFIRMATION_MS = 4_000;
type SendCommand = (command: ClientCommand) => boolean;

const haptic = (pattern: number | number[]): void => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Haptics are an optional enhancement and are unavailable on many browsers.
  }
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

function Scoreboard({ snapshot, compact = false, dialog = false }: { snapshot: RoomSnapshot; compact?: boolean; dialog?: boolean }) {
  const sorted = [...snapshot.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "fr"));
  return (
    <ol className={`scoreboard${compact ? " scoreboard--compact" : ""}${dialog ? " scoreboard--dialog" : ""}`} aria-label="Classement">
      {sorted.map((player) => {
        const isDrawer = snapshot.phase !== "finished" && snapshot.turn?.drawerId === player.id;
        return (
          <li key={player.id} className={isDrawer ? "is-drawer" : ""}>
            <span>{player.name}{isDrawer ? <small className="scoreboard__role">dessine</small> : null}</span>
            <strong aria-label={`${player.score} point${player.score > 1 ? "s" : ""}`}>{player.score}<small aria-hidden="true"> pt</small></strong>
          </li>
        );
      })}
    </ol>
  );
}

function RoundProgress({ snapshot, compact = false }: { snapshot: RoomSnapshot; compact?: boolean }) {
  const currentRound = snapshot.turn?.round ?? 0;
  const complete = snapshot.phase === "finished" ? snapshot.settings.rounds : Math.max(0, currentRound - 1);
  return <ol className={`round-progress${compact ? " round-progress--compact" : ""}`} aria-label={`Progression : manche ${Math.min(currentRound || 1, snapshot.settings.rounds)} sur ${snapshot.settings.rounds}`}>
    {Array.from({ length: snapshot.settings.rounds }, (_, index) => {
      const round = index + 1;
      const state = round <= complete ? "is-complete" : round === currentRound ? "is-current" : "";
      return <li key={round} className={state}><span className="sr-only">Manche {round}{round <= complete ? " terminée" : round === currentRound ? " en cours" : " à venir"}</span></li>;
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
      case "awaiting_ready": return { eyebrow: `Manche ${turn?.round ?? 0}/${snapshot.settings.rounds}`, title: snapshot.canDraw ? "C’est à vous : préparez-vous à dessiner." : turn ? `${turn.drawerName} prend le crayon.` : "Choix du dessinateur…" };
      case "armed": return { eyebrow: `Manche ${turn?.round ?? 0}/${snapshot.settings.rounds}`, title: "Le mot est choisi. Le chrono démarre au premier trait." };
      case "drawing": return { eyebrow: `Manche ${turn?.round ?? 0}/${snapshot.settings.rounds}`, title: snapshot.canDraw ? "Dessinez : les autres joueurs devinent." : "À vous de deviner — le dessinateur arbitre." };
      case "resolving": return { eyebrow: "Temps écoulé", title: snapshot.canSelectWinner ? "Désignez le gagnant de la manche." : "Le dessinateur désigne le gagnant." };
      case "revealing": return { eyebrow: "Réponse", title: "Le mot et les points viennent d’être révélés." };
      case "finished": return { eyebrow: "Résultat", title: "La partie est terminée." };
    }
  })();
  return <section key={`${turn?.id ?? "lobby"}-${snapshot.phase}`} className={`game-status game-status--${snapshot.phase}`} aria-live="polite"><div><p className="eyebrow">{details.eyebrow}</p><strong>{details.title}</strong></div>{countdown ? <PhaseCountdown deadlineAt={countdown} serverNow={snapshot.serverNow} label={countdownLabel} /> : <RoundProgress snapshot={snapshot} compact />}</section>;
}

function DrawingBoard({ snapshot, connected, connectionMessage, reconnectLabel, onReconnect, send, onLeave }: { snapshot: RoomSnapshot; connected: boolean; connectionMessage: string | null; reconnectLabel: string; onReconnect: () => void; send: SendCommand; onLeave: () => void }) {
  const [tool, setTool] = useState<Tool>("pen");
  const [width, setWidth] = useState(8);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [clearConfirmation, setClearConfirmation] = useState(false);
  const [winnerOpen, setWinnerOpen] = useState(false);
  const activeRef = useRef<Stroke | null>(null);
  const activeCanvasRevisionRef = useRef(0);
  const pendingRef = useRef<Point[]>([]);
  const startedRef = useRef(false);
  const lastFlushRef = useRef(0);
  const draftFrameRef = useRef<number | null>(null);
  const clearTimerRef = useRef<number | null>(null);
  const pointerPreviewRef = useRef<HTMLDivElement>(null);
  const winnerTriggerRef = useRef<HTMLButtonElement>(null);
  const winnerCloseRef = useRef<HTMLButtonElement>(null);
  const winnerSheetRef = useRef<HTMLDivElement>(null);
  const turn = snapshot.turn;

  const hidePointerPreview = (): void => {
    pointerPreviewRef.current?.classList.remove("is-visible");
  };

  const showPointerPreview = (target: HTMLCanvasElement, clientX: number, clientY: number): void => {
    const preview = pointerPreviewRef.current;
    if (!preview) return;
    const canvasBounds = target.getBoundingClientRect();
    const shellBounds = preview.parentElement?.getBoundingClientRect() ?? canvasBounds;
    const x = Math.min(canvasBounds.right, Math.max(canvasBounds.left, clientX));
    const y = Math.min(canvasBounds.bottom, Math.max(canvasBounds.top, clientY));
    preview.style.setProperty("--drawing-pointer-x", `${x - shellBounds.left}px`);
    preview.style.setProperty("--drawing-pointer-y", `${y - shellBounds.top}px`);
    preview.classList.add("is-visible");
  };

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
    setWinnerOpen(false);
    hidePointerPreview();
    cancelClearConfirmation();
  }, [turn?.canvasRevision, turn?.id]);
  useEffect(() => {
    if (connected) return;
    activeRef.current = null;
    pendingRef.current = [];
    startedRef.current = false;
    if (draftFrameRef.current) window.cancelAnimationFrame(draftFrameRef.current);
    draftFrameRef.current = null;
    setDraft(null);
    setWinnerOpen(false);
    hidePointerPreview();
    cancelClearConfirmation();
  }, [connected]);
  useEffect(() => {
    if (snapshot.phase !== "resolving") return;
    // The authoritative timer has stopped the manche. Drop any local gesture
    // still held by the pointer so it cannot remain painted over the frozen
    // canvas while the drawer chooses the winner.
    activeRef.current = null;
    pendingRef.current = [];
    startedRef.current = false;
    if (draftFrameRef.current) window.cancelAnimationFrame(draftFrameRef.current);
    draftFrameRef.current = null;
    setDraft(null);
    hidePointerPreview();
    cancelClearConfirmation();
  }, [snapshot.phase]);
  useEffect(() => {
    if (!winnerOpen) return;
    window.requestAnimationFrame(() => {
      const target = snapshot.phase === "resolving"
        ? winnerSheetRef.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? winnerSheetRef.current
        : winnerCloseRef.current;
      target?.focus();
    });
  }, [snapshot.phase, winnerOpen]);
  useEffect(() => {
    if (connected && snapshot.phase === "resolving" && snapshot.canSelectWinner) setWinnerOpen(true);
  }, [connected, snapshot.canSelectWinner, snapshot.phase, turn?.id]);

  const closeWinner = (): void => {
    setWinnerOpen(false);
    window.requestAnimationFrame(() => winnerTriggerRef.current?.focus());
  };

  const keepWinnerFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (snapshot.phase !== "resolving") closeWinner();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(winnerSheetRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])") ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

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

  const appendPoint = (active: Stroke, point: Point): boolean => {
    const previous = active.points.at(-1)!;
    // Keeping only visually distinct samples reduces message volume on high-Hz
    // touch screens without making fine curves feel polygonal.
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0012) return false;
    active.points.push(point);
    return true;
  };

  const flush = (complete: boolean): boolean => {
    const active = activeRef.current;
    if (!active || !turn || pendingRef.current.length === 0) return false;
    while (pendingRef.current.length > 0) {
      const points = pendingRef.current.slice(0, STROKE_CHUNK_SIZE);
      const isLastChunk = points.length === pendingRef.current.length;
      const sent = send({ type: "stroke", turnId: turn.id, canvasRevision: activeCanvasRevisionRef.current, stroke: { id: active.id, tool: active.tool, width: active.width, points, complete: complete && isLastChunk } });
      if (!sent) return false;
      pendingRef.current.splice(0, points.length);
    }
    lastFlushRef.current = performance.now();
    return true;
  };

  const down = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!connected || !snapshot.canDraw || !turn) return;
    showPointerPreview(event.currentTarget, event.clientX, event.clientY);
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
    activeCanvasRevisionRef.current = turn.canvasRevision;
    pendingRef.current = [];
    startedRef.current = false;
    lastFlushRef.current = performance.now();
    setDraft({ ...active, points: [...active.points] });
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!connected || !snapshot.canDraw) {
      hidePointerPreview();
      return;
    }
    showPointerPreview(event.currentTarget, event.clientX, event.clientY);
    const active = activeRef.current;
    if (!active) return;
    const target = event.currentTarget;
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    const addedPoints: Point[] = [];
    for (const sample of samples) {
      const point = pointFromCoordinates(target, sample.clientX, sample.clientY);
      if (appendPoint(active, point)) addedPoints.push(point);
    }
    const point = active.points.at(-1)!;
    if (!startedRef.current) {
      const first = active.points[0]!;
        const hasMoved = Math.hypot(point.x - first.x, point.y - first.y) > 0.003;
      if (hasMoved) {
        startedRef.current = true;
        pendingRef.current = [...active.points];
        haptic(8);
      }
    } else if (addedPoints.length > 0) {
      pendingRef.current.push(...addedPoints);
    }
    queueDraftPaint();
    if (startedRef.current && performance.now() - lastFlushRef.current >= 80) flush(false);
  };

  const enterCanvas = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (connected && snapshot.canDraw) showPointerPreview(event.currentTarget, event.clientX, event.clientY);
  };

  const up = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const active = activeRef.current;
    if (!active) {
      hidePointerPreview();
      return;
    }
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
    hidePointerPreview();
  };

  const leaveCanvas = (): void => {
    if (!activeRef.current) hidePointerPreview();
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
    <section className={`drawing-board drawing-board--terminal${connected ? "" : " is-offline"}`}>
      <div className="drawing-menu">
        <header className="drawing-menu__header">
          <span className="drawing-menu__word"><small>Mot secret</small><strong>{snapshot.secretWord}</strong></span>
          <span className="drawing-menu__timer">{snapshot.phase === "armed" ? "Le chrono démarre au premier trait" : <Timer deadlineAt={turn?.deadlineAt ?? null} serverNow={snapshot.serverNow} />}</span>
        </header>
        <div className="drawing-menu__panel">
          <div className="drawing-tools" role="group" aria-label="Outils de dessin">
            <button type="button" disabled={!snapshot.canDraw} className={tool === "pen" ? "selected" : ""} aria-pressed={tool === "pen"} onClick={() => { setTool("pen"); haptic(6); }}>Crayon</button>
            <button type="button" disabled={!snapshot.canDraw} className={tool === "eraser" ? "selected" : ""} aria-pressed={tool === "eraser"} onClick={() => { setTool("eraser"); haptic(6); }}>Gomme</button>
            <label>Épaisseur <input name="stroke-width" aria-label="Épaisseur du trait" disabled={!snapshot.canDraw} type="range" min="2" max="28" value={width} onChange={(event) => setWidth(Number(event.target.value))} /><output>{width}px</output></label>
            <button type="button" disabled={!connected || !snapshot.canDraw || !turn?.strokes.length} onClick={() => { if (turn) { haptic(6); send({ type: "undo", turnId: turn.id }); } }}>Annuler</button>
            <button type="button" disabled={!connected || !snapshot.canDraw} onClick={() => { if (turn) { haptic(6); send({ type: "redo", turnId: turn.id }); } }}>Rétablir</button>
            <button type="button" disabled={!connected || !snapshot.canDraw || !turn?.strokes.length} className={clearConfirmation ? "is-danger" : ""} onClick={clear}>{clearConfirmation ? "Confirmer l’effacement" : "Tout effacer"}</button>
          </div>
        </div>
      </div>
      <div className="drawing-canvas-shell">
        <DrawingCanvas
          strokes={turn?.strokes ?? []}
          draft={draft}
          inverse={false}
          className={`drawing-canvas${connected && snapshot.canDraw ? " is-drawable" : ""}`}
          ariaLabel={!connected ? "Zone de dessin en pause pendant la reconnexion" : snapshot.canDraw ? "Zone de dessin tactile" : "Dessin figé en attente de la décision du dessinateur"}
          ariaDisabled={!connected || !snapshot.canDraw}
          onPointerDown={down}
          onPointerEnter={enterCanvas}
          onPointerMove={move}
          onPointerUp={up}
          onPointerLeave={leaveCanvas}
        />
        <div ref={pointerPreviewRef} className={`drawing-pointer drawing-pointer--${tool}`} style={{ "--drawing-pointer-size": `${Math.round(14 + width * 0.75)}px` } as CSSProperties} aria-hidden="true" />
        {!connected ? <div className="drawing-offline" role="status"><strong>Dessin en pause</strong><span>{connectionMessage ?? "Reconnexion en cours. Reprenez votre trait quand la connexion revient."}</span><button type="button" onClick={onReconnect}>{reconnectLabel}</button></div> : null}
      </div>
      {["armed", "drawing", "resolving"].includes(snapshot.phase) && snapshot.canSelectWinner && turn ? <div className="drawing-round-action"><button type="button" className="drawing-round-action__leave" onClick={onLeave}>Quitter</button><button ref={winnerTriggerRef} type="button" className="button button--primary" disabled={!connected} onClick={() => setWinnerOpen(true)}>{snapshot.phase === "resolving" ? "Désigner le gagnant" : "Interrompre la manche et désigner le gagnant"}</button></div> : null}
      {winnerOpen && ["armed", "drawing", "resolving"].includes(snapshot.phase) && snapshot.canSelectWinner && turn ? <div className="winner-sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="winner-selection-title" onKeyDown={keepWinnerFocus} onMouseDown={(event) => { if (snapshot.phase !== "resolving" && event.target === event.currentTarget) closeWinner(); }}><div ref={winnerSheetRef} className="winner-sheet" tabIndex={-1}>{snapshot.phase !== "resolving" ? <button ref={winnerCloseRef} type="button" className="winner-sheet__close" aria-label="Fermer la sélection du gagnant" onClick={closeWinner}>×</button> : null}<WinnerSelection snapshot={snapshot} connected={connected} send={send} /></div></div> : null}
    </section>
  );
}

function TerminalScreen({ snapshot, connected, connectionMessage, reconnectLabel, onReconnect, send, onLeave }: { snapshot: RoomSnapshot; connected: boolean; connectionMessage: string | null; reconnectLabel: string; onReconnect: () => void; send: SendCommand; onLeave: () => void }) {
  const isDrawer = snapshot.canDraw || snapshot.canSelectWinner;
  const turn = snapshot.turn;
  const [scoreOpen, setScoreOpen] = useState(false);
  if (isDrawer && ["armed", "drawing", "resolving"].includes(snapshot.phase)) {
    return <main className="drawing-terminal-screen"><DrawingBoard snapshot={snapshot} connected={connected} connectionMessage={connectionMessage} reconnectLabel={reconnectLabel} onReconnect={onReconnect} send={send} onLeave={onLeave} /></main>;
  }
  return (
    <main className="role-screen player-screen screen-split">
      <section className="screen-half screen-half--primary">
        <div className="screen-half__content terminal-primary">
          <RoomHeader snapshot={snapshot} label="Téléphone de dessin" />
          {!['awaiting_ready', 'revealing', 'finished'].includes(snapshot.phase) ? <GameStatus snapshot={snapshot} /> : null}
          {snapshot.phase === "finished" ? <Finished snapshot={snapshot} /> : null}
          {snapshot.phase === "awaiting_ready" && !isDrawer && snapshot.canTakeDrawingTurn && turn ? (
            <section className="status-card"><p className="eyebrow">Manche {turn.round}/{snapshot.settings.rounds}</p><h1>{turn.drawerName} doit dessiner</h1><button className="button button--primary" disabled={!connected} onClick={() => send({ type: "take_drawing_turn", turnId: turn.id })}>Utiliser ce téléphone</button></section>
          ) : null}
          {snapshot.phase === "awaiting_ready" && !isDrawer && !snapshot.canTakeDrawingTurn ? (
            <section className="status-card"><p className="eyebrow">En attente</p><h1>{turn ? `${turn.drawerName} prépare son dessin` : "La partie se prépare"}</h1><p>Cette manche utilise déjà un autre téléphone.</p></section>
          ) : null}
          {snapshot.phase === "awaiting_ready" && isDrawer ? (
            <section className="status-card"><p className="eyebrow">C’est à vous</p><h1>Prêt·e à dessiner ?</h1><p><Timer deadlineAt={turn?.readyDeadlineAt ?? null} serverNow={snapshot.serverNow} /></p><button className="button button--primary" disabled={!connected} onClick={() => turn && send({ type: "ready", turnId: turn.id })}>Je suis prêt·e</button></section>
          ) : null}
          {snapshot.phase === "revealing" ? <Reveal snapshot={snapshot} /> : null}
        </div>
      </section>
      <section className="screen-half screen-half--secondary">
        <div className="screen-half__content terminal-controls">
          <div><p className="eyebrow">Actions</p><h2>Ce téléphone</h2></div>
          <div className="terminal-controls__actions"><button type="button" onClick={() => setScoreOpen(true)}>Classement <span>{snapshot.players.length}</span></button><button disabled={isDrawer || !connected} onClick={() => send({ type: "set_display_mode", displayMode: "projection" })}>Mode projecteur</button></div>
          {snapshot.phase === "finished" ? <p className="terminal-replay-note">L’organisateur peut préparer une nouvelle partie.</p> : null}
          <button type="button" className="room-leave-button" onClick={onLeave}>Quitter la salle</button>
        </div>
      </section>
      {scoreOpen ? <OverlayDialog label="Classement" onClose={() => setScoreOpen(false)}><Scoreboard snapshot={snapshot} dialog /></OverlayDialog> : null}
    </main>
  );
}

function WinnerSelection({ snapshot, connected, send }: { snapshot: RoomSnapshot; connected: boolean; send: SendCommand }) {
  const turn = snapshot.turn;
  const [selectedWinnerId, setSelectedWinnerId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submissionPendingRef = useRef(false);
  const submissionTimerRef = useRef<number | null>(null);
  const candidates = snapshot.players.filter((player) => player.id !== turn?.drawerId);
  useEffect(() => {
    setSelectedWinnerId(null);
    setSubmitting(false);
    submissionPendingRef.current = false;
    if (submissionTimerRef.current !== null) window.clearTimeout(submissionTimerRef.current);
    submissionTimerRef.current = null;
    return () => {
      if (submissionTimerRef.current !== null) window.clearTimeout(submissionTimerRef.current);
    };
  }, [turn?.id]);
  if (!turn) return null;
  const selectedWinner = candidates.find((player) => player.id === selectedWinnerId) ?? null;
  const submitResolution = (command: ClientCommand): boolean => {
    if (!connected || submissionPendingRef.current) return false;
    submissionPendingRef.current = true;
    setSubmitting(true);
    if (!send(command)) {
      submissionPendingRef.current = false;
      setSubmitting(false);
      return false;
    }
    submissionTimerRef.current = window.setTimeout(() => {
      submissionPendingRef.current = false;
      submissionTimerRef.current = null;
      setSubmitting(false);
    }, 2_500);
    return true;
  };
  const chooseWinner = (): void => {
    if (!selectedWinner) return;
    if (submitResolution({ type: "select_winner", turnId: turn.id, playerId: selectedWinner.id })) haptic([12, 35, 18]);
  };
  const chooseNobody = (): void => {
    if (submitResolution({ type: "no_winner", turnId: turn.id })) haptic(10);
  };
  return <section className="resolution" aria-labelledby="winner-selection-title"><div><p className="eyebrow">Décision du dessinateur</p><h2 id="winner-selection-title">Qui a gagné la manche ?</h2><p>{snapshot.phase === "resolving" ? "Le temps est écoulé. Désignez le gagnant pour continuer." : "Le gagnant devient le prochain dessinateur."}</p></div>{candidates.length > 0 ? <div className="winner-grid" role="group" aria-label="Joueur gagnant">{candidates.map((player) => <button key={player.id} type="button" disabled={!connected || submitting} className={`winner-button${selectedWinnerId === player.id ? " is-selected" : ""}`} aria-pressed={selectedWinnerId === player.id} onClick={() => { setSelectedWinnerId(player.id); haptic(8); }}><span className="winner-button__name">{player.name}</span><span className="winner-button__point">Prochain dessinateur</span></button>)}</div> : <p className="resolution-empty">Vous êtes seul·e dans cette partie : choisissez « Aucun gagnant » pour continuer.</p>}<div className="resolution-actions"><button type="button" className="button button--primary" disabled={!connected || !selectedWinner || submitting} onClick={chooseWinner}>{submitting ? "Validation…" : selectedWinner ? `Choisir ${selectedWinner.name}` : "Choisissez le gagnant"}</button><button type="button" className="no-winner-button" disabled={!connected || submitting} onClick={chooseNobody}>{submitting ? "Validation…" : "Aucun gagnant — tirage au sort"}</button></div></section>;
}

function ToggleList<T extends string>({
  values, selected, toggle, label,
}: {
  values: readonly T[];
  selected: T[];
  toggle: (value: T) => void;
  label: (value: T) => string;
}) {
  return <div className="toggle-list" role="group" aria-label="Difficultés des mots, plusieurs choix possibles">{values.map((value) => <button key={value} type="button" className={selected.includes(value) ? "selected" : ""} aria-pressed={selected.includes(value)} onClick={() => toggle(value)}>{label(value)}</button>)}</div>;
}

function OverlayDialog({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, []);
  const keepFocusInside = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex='-1'])") ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return <section className="app-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={panelRef} className="app-modal" role="dialog" aria-modal="true" aria-label={label} onKeyDown={keepFocusInside}><header className="app-modal__header"><h2>{label}</h2><button ref={closeRef} type="button" aria-label={`Fermer ${label}`} onClick={onClose}>×</button></header>{children}</div></section>;
}

function DeleteRoomDialog({ connected, onDelete, onClose }: { connected: boolean; onDelete: () => boolean; onClose: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const deleteRoom = (): void => {
    if (onDelete()) setDeleting(true);
  };
  return <OverlayDialog label="Supprimer la partie" onClose={onClose}><div className="delete-room-dialog"><p>La salle sera supprimée définitivement et tous les téléphones encore connectés seront déconnectés.</p><div className="delete-room-dialog__actions"><button type="button" disabled={deleting} onClick={onClose}>Annuler</button><button type="button" className="button--danger" disabled={!connected || deleting} onClick={deleteRoom}>{deleting ? "Suppression…" : "Supprimer la partie"}</button></div></div></OverlayDialog>;
}

function PlayerEditor({ snapshot, connected, send, playerName, onPlayerNameChange }: { snapshot: RoomSnapshot; connected: boolean; send: SendCommand; playerName: string; onPlayerNameChange: (value: string) => void }) {
  return <div className="player-editor"><form className="player-editor__form" onSubmit={(event) => { event.preventDefault(); if (!playerName.trim()) return; if (send({ type: "add_player", name: playerName })) onPlayerNameChange(""); }}><label>Nom du joueur<input name="player-name" value={playerName} placeholder="ex. Lila" maxLength={24} onChange={(event) => onPlayerNameChange(event.target.value)} /></label><button type="submit" className="button button--primary" disabled={!connected || playerName.trim().length < 2 || snapshot.players.length >= 12}>Ajouter</button></form><p className="modal-summary">{snapshot.players.length}/12 joueurs</p>{snapshot.players.length > 0 ? <ul className="player-editor__list">{snapshot.players.map((player) => <li key={player.id}><button type="button" disabled={!connected} aria-label={`Retirer ${player.name} de la partie`} onClick={() => send({ type: "remove_player", playerId: player.id })}><span>{player.name}</span><b aria-hidden="true">×</b></button></li>)}</ul> : <p className="modal-summary">Ajoutez le premier joueur.</p>}</div>;
}

function ControllerScreen({ snapshot, connected, send }: { snapshot: RoomSnapshot; connected: boolean; send: SendCommand }) {
  const [settings, setSettings] = useState<Settings>(snapshot.settings);
  const [playerName, setPlayerName] = useState("");
  const [playersOpen, setPlayersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const launchPendingRef = useRef(false);
  const launchTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (launchTimerRef.current !== null) window.clearTimeout(launchTimerRef.current);
  }, []);
  const toggleDifficulty = (value: Difficulty): void => {
    setSettings((previous) => {
      const list = previous.difficulties;
      const next = list.includes(value) ? list.filter((candidate) => candidate !== value) : [...list, value];
      return { ...previous, difficulties: next };
    });
  };
  const joinUrl = `${window.location.origin}/?join=${snapshot.code}`;
  const launch = (): void => {
    if (!connected || launchPendingRef.current) return;
    launchPendingRef.current = true;
    setLaunching(true);
    if (!send({ type: "start_game", settings })) {
      launchPendingRef.current = false;
      setLaunching(false);
      return;
    }
    launchTimerRef.current = window.setTimeout(() => {
      launchPendingRef.current = false;
      launchTimerRef.current = null;
      setLaunching(false);
    }, 2_500);
  };
  const canLaunch = connected
    && !launching
    && snapshot.players.length >= 1
    && settings.difficulties.length > 0
    && snapshot.devicePresence.hasRequiredDevices;
  const launchHelp = !connected
    ? "Reconnectez la salle pour démarrer."
    : snapshot.players.length < 1
      ? "Ajoutez au moins un joueur."
      : !snapshot.devicePresence.hasRequiredDevices
        ? "Gardez ce projecteur connecté et rejoignez la salle avec un autre téléphone en mode dessin."
        : settings.difficulties.length === 0
          ? "Choisissez au moins une difficulté."
          : "Tout est prêt pour démarrer.";
  return (
    <main className="role-screen controller-screen screen-split">
      <section className="screen-half screen-half--invite">
        <div className="screen-half__content screen-half__content--invite">
          <div className="invite-scroll">
            <RoomHeader snapshot={snapshot} label="Préparation" />
            <section className="join-card">
              <div><p className="eyebrow">Inviter les téléphones</p><h1>{snapshot.code}</h1><a className="sr-only" href={joinUrl}>Lien direct pour rejoindre la salle {snapshot.code}</a></div>
              <figure className="join-qr" role="img" aria-label={`QR code pour rejoindre directement la salle ${snapshot.code}`}><Suspense fallback={<div className="qr-placeholder" aria-label="Génération du QR code" />}><RoomQrCode value={joinUrl} size={136} bgColor="#ffffff" fgColor="#101326" includeMargin /></Suspense><figcaption className="sr-only">Scannez pour rejoindre directement la salle {snapshot.code}.</figcaption></figure>
            </section>
          </div>
          <footer className="invite-actions">
            <div className="device-readiness" aria-live="polite"><span className={snapshot.devicePresence.projectors > 0 ? "is-ready" : ""}>Projecteur {snapshot.devicePresence.projectors > 0 ? "prêt" : "absent"}</span><span className={snapshot.devicePresence.drawingPhones > 0 ? "is-ready" : ""}>Téléphone de dessin {snapshot.devicePresence.drawingPhones > 0 ? "prêt" : "absent"}</span></div>
            <p id="launch-help" className="launch-help">{launchHelp}</p>
            <button className="button button--primary" aria-describedby="launch-help" disabled={!canLaunch} onClick={launch}>{launching ? "Lancement…" : "Démarrer la partie"}</button>
          </footer>
        </div>
      </section>
      <section className="screen-half screen-half--setup">
        <div className="screen-half__content setup-overview">
          <div><p className="eyebrow">Préparer la partie</p><h2>Joueurs et réglages</h2><p className="setup-summary">{settings.durationSeconds} s · {settings.rounds} manches · {settings.difficulties.length} niveau{settings.difficulties.length > 1 ? "x" : ""}</p></div>
          <div className="setup-overview__actions"><button type="button" className={`setup-players-button${snapshot.players.length === 0 ? " is-needed" : ""}`} aria-label={`Gérer les joueurs : ${snapshot.players.length} sur 12${snapshot.players.length === 0 ? ". Ajoutez le premier joueur." : ""}`} onClick={() => setPlayersOpen(true)}><span>Joueurs</span><strong><b>{snapshot.players.length}</b><small>/12</small></strong>{snapshot.players.length === 0 ? <em>Ajouter un joueur</em> : null}</button><button type="button" onClick={() => setSettingsOpen(true)}>Réglages</button></div>
          <button type="button" className="room-delete-button" onClick={() => setDeleteOpen(true)}>Supprimer la partie</button>
        </div>
      </section>
      {playersOpen ? <OverlayDialog label="Joueurs" onClose={() => setPlayersOpen(false)}><PlayerEditor snapshot={snapshot} connected={connected} send={send} playerName={playerName} onPlayerNameChange={setPlayerName} /></OverlayDialog> : null}
      {settingsOpen ? <OverlayDialog label="Réglages de la partie" onClose={() => setSettingsOpen(false)}><div className="settings-editor"><div className="settings-fields"><label>Durée <select name="duration" value={settings.durationSeconds} onChange={(event) => setSettings({ ...settings, durationSeconds: Number(event.target.value) as Settings["durationSeconds"] })}>{DURATIONS.map((duration) => <option key={duration} value={duration}>{duration} secondes</option>)}</select></label><label>Nombre de manches <select name="rounds" value={settings.rounds} onChange={(event) => setSettings({ ...settings, rounds: Number(event.target.value) as Settings["rounds"] })}>{ROUND_COUNTS.map((rounds) => <option key={rounds} value={rounds}>{rounds} manches</option>)}</select></label></div><h3>Difficultés des mots</h3><ToggleList values={DIFFICULTIES} selected={settings.difficulties} toggle={toggleDifficulty} label={(value) => value[0]!.toUpperCase() + value.slice(1)} /></div></OverlayDialog> : null}
      {deleteOpen ? <DeleteRoomDialog connected={connected} onDelete={() => send({ type: "delete_room" })} onClose={() => setDeleteOpen(false)} /> : null}
    </main>
  );
}

function Reveal({ snapshot }: { snapshot: RoomSnapshot }) {
  const winner = snapshot.players.find((player) => player.id === snapshot.turn?.winnerId);
  return <section className={`reveal-card${winner ? " reveal-card--success" : ""}`} aria-live="assertive"><Celebration /><p className="eyebrow">La réponse était</p><h1>{snapshot.turn?.revealedWord}</h1><p>{winner ? <><strong>Bravo {winner.name} !</strong> Il devient le prochain dessinateur. +1 point pour lui et pour le dessinateur.</> : "Aucun gagnant : le prochain dessinateur a été tiré au sort."}</p></section>;
}

function Finished({ snapshot }: { snapshot: RoomSnapshot }) {
  const winners = snapshot.players.filter((player) => snapshot.finishedWinnerIds.includes(player.id));
  return <section className="finished-card" aria-live="assertive"><Celebration /><p className="eyebrow">Partie terminée</p><h1>{winners.map((player) => player.name).join(" et ")}</h1><p>{winners.length > 1 ? "sont ex æquo !" : "remporte la partie !"}</p></section>;
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
    if (snapshot.phase === "resolving") return { title: "Temps écoulé", detail: "Le dessinateur désigne le gagnant." };
    if (snapshot.phase === "revealing") return { title: "La réponse était", detail: turn?.revealedWord ?? "" };
    if (snapshot.phase === "finished") return { title: "Partie terminée", detail: "Score final affiché." };
    return null;
  })();
  if (!content) return null;
  return <div key={`${turn?.id ?? "lobby"}-${snapshot.phase}`} className="holo-cue"><strong>{content.title}</strong><span>{content.detail}</span>{content.deadlineAt && content.deadlineLabel ? <PhaseCountdown deadlineAt={content.deadlineAt} serverNow={snapshot.serverNow} label={content.deadlineLabel} /> : null}</div>;
}

type ProjectionFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

const projectionFullscreenActive = (): boolean => {
  const fullscreenDocument = document as ProjectionFullscreenDocument;
  return Boolean(document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement);
};

const requestProjectionFullscreen = async (): Promise<boolean> => {
  const fullscreenElement = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
  const request = fullscreenElement.requestFullscreen?.bind(fullscreenElement) ?? fullscreenElement.webkitRequestFullscreen?.bind(fullscreenElement);
  try {
    await request?.();
  } catch {
    // iOS and embedded browsers can refuse native fullscreen. CSS immersive
    // mode remains active so the two-face projection still fills the viewport.
  }
  return projectionFullscreenActive();
};

const exitProjectionFullscreen = async (): Promise<void> => {
  const fullscreenDocument = document as ProjectionFullscreenDocument;
  const exit = document.exitFullscreen?.bind(document) ?? fullscreenDocument.webkitExitFullscreen?.bind(fullscreenDocument);
  try {
    await exit?.();
  } catch {
    // Exiting is best effort when the browser already released fullscreen.
  }
};

function ProjectionScreen({ snapshot, connected, connectionMessage, reconnectLabel, onReconnect, onLeave, onUseDrawingTerminal, onPrepareNewGame, onDeleteRoom }: { snapshot: RoomSnapshot; connected: boolean; connectionMessage: string | null; reconnectLabel: string; onReconnect: () => void; onLeave: () => void; onUseDrawingTerminal?: () => void; onPrepareNewGame?: () => boolean; onDeleteRoom?: () => boolean }) {
  const [calibration, setCalibration] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawingControlsVisible, setDrawingControlsVisible] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [preparingNewGame, setPreparingNewGame] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(false);
  const fullscreenOperationRef = useRef(0);
  const fullscreenQueueRef = useRef<Promise<void>>(Promise.resolve());
  const fullscreenEnterPendingRef = useRef(false);
  const fullscreenRequestedByComponentRef = useRef(false);
  const presentationRequestedRef = useRef(false);
  const nativeFullscreenSeenRef = useRef(false);
  const ownsFullscreenRef = useRef(false);
  const prepareNewGamePendingRef = useRef(false);
  const prepareNewGameTimerRef = useRef<number | null>(null);
  const presentationMode = immersive || nativeFullscreen;
  const isDrawing = snapshot.phase === "drawing";
  const openSettings = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
    settingsTriggerRef.current = event.currentTarget;
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => settingsTriggerRef.current?.focus());
  }, []);
  const openDeleteRoom = useCallback((): void => {
    closeSettings();
    setDeleteOpen(true);
  }, [closeSettings]);
  const queueFullscreenAction = useCallback((action: () => Promise<void>): Promise<void> => {
    const request = fullscreenQueueRef.current.catch(() => undefined).then(action);
    fullscreenQueueRef.current = request.catch(() => undefined);
    return request;
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      const shouldExitNativeFullscreen = ownsFullscreenRef.current || fullscreenRequestedByComponentRef.current;
      mountedRef.current = false;
      presentationRequestedRef.current = false;
      fullscreenEnterPendingRef.current = false;
      fullscreenRequestedByComponentRef.current = false;
      fullscreenOperationRef.current += 1;
      ownsFullscreenRef.current = false;
      nativeFullscreenSeenRef.current = false;
      if (prepareNewGameTimerRef.current !== null) window.clearTimeout(prepareNewGameTimerRef.current);
      if (shouldExitNativeFullscreen) {
        void exitProjectionFullscreen();
        void queueFullscreenAction(exitProjectionFullscreen);
      }
    };
  }, [queueFullscreenAction]);
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    let disposed = false;
    const acquireWakeLock = async (): Promise<void> => {
      if (disposed || document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
      if (wakeLock && !wakeLock.released) return;
      wakeLock = null;
      try {
        const lock = await (navigator as Navigator & { wakeLock: { request: (type: "screen") => Promise<WakeLockSentinel> } }).wakeLock.request("screen");
        if (disposed) {
          await lock.release();
          return;
        }
        wakeLock = lock;
        lock.addEventListener("release", () => {
          if (wakeLock === lock) wakeLock = null;
        });
      } catch {
        // The screen lock is optional and can be denied by the browser or OS.
      }
    };
    const reacquireWhenVisible = (): void => {
      if (document.visibilityState === "visible") void acquireWakeLock();
    };
    document.addEventListener("visibilitychange", reacquireWhenVisible);
    void acquireWakeLock();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", reacquireWhenVisible);
      void wakeLock?.release();
      wakeLock = null;
    };
  }, []);
  useEffect(() => {
    const syncFullscreen = (): void => {
      if (!mountedRef.current) return;
      const active = projectionFullscreenActive();
      setNativeFullscreen(active);
      if (active) {
        nativeFullscreenSeenRef.current = true;
        return;
      }
      // Do not turn off the CSS fallback merely because the browser has no
      // native Fullscreen API. Only a real native fullscreen exit ends it.
      if (!nativeFullscreenSeenRef.current) return;
      nativeFullscreenSeenRef.current = false;
      ownsFullscreenRef.current = false;
      if (presentationRequestedRef.current && fullscreenEnterPendingRef.current) return;
      presentationRequestedRef.current = false;
      fullscreenRequestedByComponentRef.current = false;
      fullscreenOperationRef.current += 1;
      setImmersive(false);
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("webkitfullscreenchange", syncFullscreen);
    syncFullscreen();
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("webkitfullscreenchange", syncFullscreen);
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("projection-immersive", presentationMode);
    return () => document.documentElement.classList.remove("projection-immersive");
  }, [presentationMode]);
  useEffect(() => {
    if (isDrawing) setSettingsOpen(false);
    setDrawingControlsVisible(false);
  }, [isDrawing]);
  useEffect(() => {
    if (!isDrawing || !drawingControlsVisible) return undefined;
    const timer = window.setTimeout(() => setDrawingControlsVisible(false), 3_000);
    return () => window.clearTimeout(timer);
  }, [drawingControlsVisible, isDrawing]);
  const enterFullscreen = async (): Promise<void> => {
    const operation = ++fullscreenOperationRef.current;
    presentationRequestedRef.current = true;
    fullscreenEnterPendingRef.current = true;
    fullscreenRequestedByComponentRef.current = true;
    setImmersive(true);
    await queueFullscreenAction(async () => {
      if (!mountedRef.current || operation !== fullscreenOperationRef.current || !presentationRequestedRef.current) return;
      const active = await requestProjectionFullscreen();
      if (!mountedRef.current || operation !== fullscreenOperationRef.current || !presentationRequestedRef.current) return;
      ownsFullscreenRef.current = active;
      fullscreenEnterPendingRef.current = false;
    });
  };
  const exitFullscreen = async (): Promise<void> => {
    const operation = ++fullscreenOperationRef.current;
    presentationRequestedRef.current = false;
    fullscreenEnterPendingRef.current = false;
    fullscreenRequestedByComponentRef.current = false;
    setImmersive(false);
    await queueFullscreenAction(async () => {
      await exitProjectionFullscreen();
      if (operation === fullscreenOperationRef.current) ownsFullscreenRef.current = false;
    });
  };
  const prepareNewGame = (): void => {
    if (!connected || !onPrepareNewGame || prepareNewGamePendingRef.current) return;
    prepareNewGamePendingRef.current = true;
    setPreparingNewGame(true);
    if (!onPrepareNewGame()) {
      prepareNewGamePendingRef.current = false;
      setPreparingNewGame(false);
      return;
    }
    prepareNewGameTimerRef.current = window.setTimeout(() => {
      prepareNewGamePendingRef.current = false;
      prepareNewGameTimerRef.current = null;
      setPreparingNewGame(false);
    }, 2_500);
  };
  // The complete V composition is rotated 90° clockwise: the former left
  // face is on top (180°) and the former right face is below (0°).
  return <main className={`projection-screen${presentationMode ? " projection-screen--immersive" : ""}${isDrawing ? " projection-screen--drawing" : ""}`}>
    <header className={`projection-header${presentationMode || isDrawing ? " projection-header--hidden" : ""}`}><div><span className="brand">PICTIOFADY</span><span className="connection">Salle {snapshot.code}</span></div><div className="projection-controls">{onPrepareNewGame && snapshot.phase === "finished" ? <button className="button button--primary" disabled={!connected || preparingNewGame} onClick={prepareNewGame}>{preparingNewGame ? "Préparation…" : "Préparer une nouvelle partie"}</button> : null}{onUseDrawingTerminal ? <button onClick={onUseDrawingTerminal}>Mode dessin</button> : null}<button onClick={openSettings}>Réglages</button><button className="button button--primary" onClick={() => void enterFullscreen()}>Activer la projection</button></div></header>
    <section className="projection-stage" aria-label={isDrawing ? "Projection du dessin. Touchez l’écran pour afficher brièvement les contrôles." : "Zone de projection en V à deux faces"} onPointerUp={() => { if (isDrawing) setDrawingControlsVisible(true); }}>
      {VEE_FACE_ROTATIONS.map((rotation, index) => <div key={rotation} className={`projection-copy projection-copy--${rotation}`} aria-hidden={index > 0}>
        {calibration && !isDrawing ? <CalibrationMark number={index + 1} /> : <>{!isDrawing ? <><div className="holo-hud"><span>Manche {snapshot.turn?.round ?? 0}/{snapshot.settings.rounds}</span><Timer deadlineAt={snapshot.turn?.deadlineAt ?? null} serverNow={snapshot.serverNow} /><span>{snapshot.turn?.revealedWord ?? ""}</span></div><ProjectionCue snapshot={snapshot} /><div className="holo-scores"><Scoreboard snapshot={snapshot} compact /></div></> : null}<DrawingCanvas strokes={snapshot.turn?.strokes ?? []} inverse className="hologram-canvas" ariaLabel="Projection du dessin en cours" /></>}
      </div>)}
    </section>
    {!isDrawing ? <p className="projection-help">Placez le plexiglas au centre de la mire. Le fond noir et les traits lumineux sont optimisés pour la réflexion.</p> : null}
    {presentationMode && !isDrawing ? <div className="projection-presentation-actions">{onPrepareNewGame && snapshot.phase === "finished" ? <button disabled={!connected || preparingNewGame} onClick={prepareNewGame}>{preparingNewGame ? "Préparation…" : "Nouvelle partie"}</button> : null}{onUseDrawingTerminal ? <button aria-label="Passer en mode dessin" onClick={onUseDrawingTerminal}>Dessin</button> : null}<button aria-label="Ouvrir les réglages de projection" onClick={openSettings}>Réglages</button><button aria-label="Quitter le plein écran" onClick={() => void exitFullscreen()}>Quitter</button></div> : null}
    {isDrawing && drawingControlsVisible ? <div className="projection-drawing-actions" role="toolbar" aria-label="Contrôles temporaires de projection" onPointerUp={(event) => event.stopPropagation()}>{onUseDrawingTerminal ? <button onClick={onUseDrawingTerminal}>Mode dessin</button> : null}<button onClick={openSettings}>Réglages</button>{presentationMode ? <button onClick={() => void exitFullscreen()}>Quitter le plein écran</button> : null}</div> : null}
    {isDrawing && !connected ? <div className="projection-interrupted" role="alert"><strong>Projection interrompue</strong><span>{connectionMessage ?? "La connexion à la partie est perdue."}</span><button type="button" onClick={onReconnect}>{reconnectLabel}</button></div> : null}
    {settingsOpen ? <ProjectionSettings snapshot={snapshot} calibration={calibration} onCalibrationChange={setCalibration} onUseDrawingTerminal={onUseDrawingTerminal} onLeave={onLeave} onDeleteRoom={onDeleteRoom ? openDeleteRoom : undefined} onClose={closeSettings} /> : null}
    {deleteOpen && onDeleteRoom ? <DeleteRoomDialog connected={connected} onDelete={onDeleteRoom} onClose={() => setDeleteOpen(false)} /> : null}
  </main>;
}

function ProjectionSettings({ snapshot, calibration, onCalibrationChange, onUseDrawingTerminal, onLeave, onDeleteRoom, onClose }: { snapshot: RoomSnapshot; calibration: boolean; onCalibrationChange: (value: boolean) => void; onUseDrawingTerminal?: () => void; onLeave: () => void; onDeleteRoom?: () => void; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  const keepFocusInside = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex='-1'])") ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return <section className="projection-settings-backdrop" role="dialog" aria-modal="true" aria-labelledby="projection-settings-title" onKeyDown={keepFocusInside} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panelRef} className="projection-settings-panel">
      <div className="projection-settings-heading"><div><p className="eyebrow">Projection</p><h1 id="projection-settings-title">Réglages</h1></div><button ref={closeRef} className="projection-settings-close" aria-label="Fermer les réglages" onClick={onClose}>×</button></div>
      <button onClick={() => onCalibrationChange(!calibration)}>{calibration ? "Voir le jeu" : "Afficher la mire"}</button>
      {onUseDrawingTerminal ? <button onClick={onUseDrawingTerminal}>Revenir au mode dessin</button> : null}
      {onDeleteRoom ? <button type="button" className="projection-settings-leave" onClick={onDeleteRoom}>Supprimer la partie</button> : <button type="button" className="projection-settings-leave" onClick={onLeave}>Quitter la salle</button>}
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

function Home({ onSession }: { onSession: (session: StoredSession) => void }) {
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
  return <main className="home"><section className="hero"><span className="brand">PICTIOFADY</span><p className="eyebrow">Nouvelle partie</p><h1>Créer une partie</h1><button className="button button--primary" disabled={busy} onClick={() => void create()}>Créer la salle <span aria-hidden="true">→</span></button></section><section className="join-panel"><p className="eyebrow">Code reçu</p><h2>Rejoindre une partie</h2><div className="join-code"><JoinCodeInput value={code} disabled={busy} onChange={updateCode} />{busy ? <p className="join-code__status" role="status">Connexion à la salle…</p> : null}</div>{error ? <div className="join-error"><p className="error-message" role="alert">{error}</p>{code.length === ROOM_CODE_LENGTH ? <button type="button" disabled={busy} onClick={() => { attemptedCodeRef.current = null; void join(code); }}>Réessayer</button> : null}</div> : null}</section></main>;
}

export function App() {
  const [session, setSession] = useState<StoredSession | null>(() => directJoinCode().length === ROOM_CODE_LENGTH ? null : loadSession());
  const pwa = usePwaLifecycle();
  const { snapshot, connectionError, connected, retry, send, sessionUnavailable } = useRoomConnection(session);
  const adoptSession = (next: StoredSession): void => { saveSession(next); setSession(next); };
  const leave = (): void => { saveSession(null); setSession(null); };
  if (!session) return <><PwaUpdateNotice pwa={pwa} /><Home onSession={adoptSession} /></>;
  if (!snapshot) return <><PwaUpdateNotice pwa={pwa} /><main className="loading screen-split"><section className="screen-half screen-half--primary"><div className="screen-half__content"><span className="brand">PICTIOFADY</span><h1>Connexion à la salle {session.code}</h1></div></section><section className="screen-half screen-half--secondary"><div className="screen-half__content"><p>{connectionError ?? "Synchronisation de la partie…"}</p><button onClick={leave}>Quitter</button></div></section></main></>;
  const reconnectAction = sessionUnavailable ? leave : retry;
  const reconnectLabel = sessionUnavailable ? "Retour à l’accueil" : "Réessayer";
  const drawingTerminalActive = session.role === "terminal" && snapshot.displayMode === "drawing" && (
    (snapshot.canDraw && ["armed", "drawing"].includes(snapshot.phase))
    || (snapshot.canSelectWinner && snapshot.phase === "resolving")
  );
  const projectionDrawingActive = snapshot.phase === "drawing" && (session.role === "controller" || snapshot.displayMode === "projection");
  const hideGlobalConnection = drawingTerminalActive || projectionDrawingActive;
  return <>{!["drawing", "resolving"].includes(snapshot.phase) ? <PwaUpdateNotice pwa={pwa} /> : null}{!connected && !hideGlobalConnection ? <div className="connection-banner is-offline" role="status"><span>{connectionError ?? "Reconnexion…"}</span><button type="button" onClick={reconnectAction}>{reconnectLabel}</button></div> : null}{connected && connectionError && !projectionDrawingActive ? <p className="connection-message" role="alert">{connectionError}</p> : null}{session.role === "controller" ? snapshot.phase === "lobby" ? <ControllerScreen snapshot={snapshot} connected={connected} send={send} /> : <ProjectionScreen snapshot={snapshot} connected={connected} connectionMessage={connectionError} reconnectLabel={reconnectLabel} onReconnect={reconnectAction} onLeave={leave} onPrepareNewGame={connected ? () => send({ type: "return_to_lobby" }) : undefined} onDeleteRoom={connected ? () => send({ type: "delete_room" }) : undefined} /> : null}{session.role === "terminal" ? snapshot.displayMode === "projection" ? <ProjectionScreen snapshot={snapshot} connected={connected} connectionMessage={connectionError} reconnectLabel={reconnectLabel} onReconnect={reconnectAction} onLeave={leave} onUseDrawingTerminal={connected ? () => { send({ type: "set_display_mode", displayMode: "drawing" }); } : undefined} /> : <TerminalScreen snapshot={snapshot} connected={connected} connectionMessage={connectionError} reconnectLabel={reconnectLabel} onReconnect={reconnectAction} send={send} onLeave={leave} /> : null}</>;
}
