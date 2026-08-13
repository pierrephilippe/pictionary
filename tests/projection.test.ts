import { describe, expect, it, vi } from "vitest";
import {
  loadProjectionLayout,
  lockProjectionOrientation,
  PROJECTION_LAYOUTS,
  projectionOrientationMatches,
  saveProjectionLayout,
  unlockProjectionOrientation,
} from "../src/client/projection";

describe("projection et orientation", () => {
  it("associe chaque support à son orientation et à ses faces", () => {
    expect(PROJECTION_LAYOUTS).toEqual({
      pyramid: { orientation: "portrait", copies: [0, 90, 180, 270] },
      vee: { orientation: "landscape", copies: [90, 270] },
      single: { orientation: "landscape", copies: [0] },
    });
    expect(projectionOrientationMatches("pyramid", 390, 844)).toBe(true);
    expect(projectionOrientationMatches("pyramid", 844, 390)).toBe(false);
    expect(projectionOrientationMatches("vee", 844, 390)).toBe(true);
    expect(projectionOrientationMatches("single", 390, 844)).toBe(false);
  });

  it("verrouille l’orientation demandée et bascule en mode manuel en cas de refus", async () => {
    const lock = vi.fn().mockResolvedValue(undefined);
    expect(await lockProjectionOrientation("vee", { lock })).toBe("locked");
    expect(lock).toHaveBeenCalledWith("landscape");

    const rejectedLock = vi.fn().mockRejectedValue(new DOMException("refusé"));
    expect(await lockProjectionOrientation("pyramid", { lock: rejectedLock })).toBe("manual");
    expect(await lockProjectionOrientation("single", undefined)).toBe("manual");
  });

  it("libère le verrou sans propager une erreur navigateur", () => {
    const unlock = vi.fn(() => { throw new DOMException("déjà libéré"); });
    expect(() => unlockProjectionOrientation({ unlock })).not.toThrow();
    expect(unlock).toHaveBeenCalledOnce();
  });

  it("conserve uniquement un support connu", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    };
    expect(loadProjectionLayout(storage)).toBe("pyramid");
    saveProjectionLayout(storage, "single");
    expect(loadProjectionLayout(storage)).toBe("single");
    stored.set("pictiofady.projection-layout", "unknown");
    expect(loadProjectionLayout(storage)).toBe("pyramid");
  });
});
