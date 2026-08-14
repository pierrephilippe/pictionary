import { describe, expect, it } from "vitest";
import { MAX_POINTS_PER_STROKE, type Point, type Stroke } from "../src/domain/types";
import { canAppendStrokes, createStrokeContinuation, describeStrokes, shouldContinueStroke } from "../src/client/drawing/model";

const stroke = (id: string, points: number, complete = false): Stroke => ({
  id,
  tool: "pen",
  width: 8,
  complete,
  points: Array.from({ length: points }, (_, index) => ({ x: index / Math.max(1, points), y: 0.5 })),
});

describe("rendu incrémental du canevas", () => {
  it("n’ajoute que les nouveaux segments lorsque le trait courant grandit", () => {
    const previous = describeStrokes([stroke("trait-a", 2)]);
    expect(canAppendStrokes(previous, [stroke("trait-a", 4)])).toBe(true);
    expect(canAppendStrokes(previous, [stroke("trait-a", 4), stroke("trait-b", 1)])).toBe(true);
  });

  it("reconstruit le buffer après une annulation, un remplacement ou un changement d’outil", () => {
    const previous = describeStrokes([stroke("trait-a", 3, true)]);
    expect(canAppendStrokes(previous, [])).toBe(false);
    expect(canAppendStrokes(previous, [stroke("trait-b", 3, true)])).toBe(false);
    expect(canAppendStrokes(previous, [{ ...stroke("trait-a", 3, true), tool: "eraser" }])).toBe(false);
  });

  it("scinde un geste continu avant la limite autoritaire sans casser sa trajectoire", () => {
    const samples: Point[] = Array.from({ length: 1_100 }, (_, index) => ({ x: index / 1_099, y: 0.5 }));
    const segments: Stroke[] = [{ id: "trait-0", tool: "pen", width: 8, points: [samples[0]!], complete: false }];
    for (const point of samples.slice(1)) {
      let current = segments.at(-1)!;
      if (shouldContinueStroke(current)) {
        current.complete = true;
        current = createStrokeContinuation(current, `trait-${segments.length}`);
        segments.push(current);
      }
      current.points.push(point);
    }

    expect(segments).toHaveLength(2);
    expect(Math.max(...segments.map((segment) => segment.points.length))).toBeLessThanOrEqual(MAX_POINTS_PER_STROKE - 1);
    expect(segments[0]!.points.at(-1)).toEqual(segments[1]!.points[0]);
    expect(segments.reduce((total, segment) => total + segment.points.length, 0)).toBe(samples.length + 1);
  });
});
