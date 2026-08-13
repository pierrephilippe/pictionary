import type { Stroke, Tool } from "../../domain/types";

export interface PaintedStroke {
  id: string;
  tool: Tool;
  width: number;
  pointCount: number;
  complete: boolean;
}

export function drawStroke(
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
