import { describe, expect, it } from "vitest";
import type { Stroke } from "../src/domain/types";
import { canAppendStrokes, describeStrokes } from "../src/client/drawing/model";

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
});
