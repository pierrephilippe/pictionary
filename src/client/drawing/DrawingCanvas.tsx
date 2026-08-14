import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import type { Stroke } from "../../domain/types";
import { canAppendStrokes, describeStrokes, drawStroke, type PaintedStroke } from "./model";

interface DrawingCanvasProps {
  strokes: Stroke[];
  draft?: Stroke | null;
  inverse: boolean;
  className?: string;
  onPointerDown?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerEnter?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLCanvasElement>) => void;
  ariaLabel?: string;
  ariaDisabled?: boolean;
}

export function DrawingCanvas({
  strokes,
  draft,
  inverse,
  className,
  onPointerDown,
  onPointerEnter,
  onPointerMove,
  onPointerUp,
  onPointerLeave,
  ariaLabel,
  ariaDisabled,
}: DrawingCanvasProps) {
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
      aria-disabled={ariaDisabled}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
    />
  );
}
