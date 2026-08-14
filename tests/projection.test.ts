import { describe, expect, it } from "vitest";
import { VEE_FACE_ROTATIONS } from "../src/client/projection";

describe("projection en V", () => {
  it("tourne la composition complète de 90° dans un ordre stable", () => {
    expect(VEE_FACE_ROTATIONS).toEqual([180, 0]);
    expect(new Set(VEE_FACE_ROTATIONS).size).toBe(2);
  });
});
