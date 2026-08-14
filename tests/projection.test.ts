import { describe, expect, it } from "vitest";
import { VEE_FACE_ROTATIONS } from "../src/client/projection";

describe("projection en V", () => {
  it("rend exactement les deux faces dans un ordre stable", () => {
    expect(VEE_FACE_ROTATIONS).toEqual([90, 270]);
    expect(new Set(VEE_FACE_ROTATIONS).size).toBe(2);
  });
});
