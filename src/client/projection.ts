import type { ProjectionLayout } from "../domain/types";

export type ProjectionOrientation = "portrait" | "landscape";
export type OrientationLockState = "idle" | "locked" | "manual";

export const PROJECTION_LAYOUTS = {
  pyramid: { orientation: "portrait", copies: [0, 90, 180, 270] },
  vee: { orientation: "landscape", copies: [90, 270] },
  single: { orientation: "landscape", copies: [0] },
} as const satisfies Record<ProjectionLayout, { orientation: ProjectionOrientation; copies: readonly number[] }>;

const PROJECTION_LAYOUT_KEY = "pictiofady.projection-layout";

export interface OrientationController {
  lock?: (orientation: ProjectionOrientation) => Promise<void>;
  unlock?: () => void;
}

export interface ProjectionOrientationLock {
  lock: (layout: ProjectionLayout) => Promise<void>;
  release: () => void;
  cancel: () => void;
}

export const requiredProjectionOrientation = (layout: ProjectionLayout): ProjectionOrientation =>
  PROJECTION_LAYOUTS[layout].orientation;

export const projectionOrientationMatches = (layout: ProjectionLayout, width: number, height: number): boolean =>
  requiredProjectionOrientation(layout) === (height >= width ? "portrait" : "landscape");

export async function lockProjectionOrientation(
  layout: ProjectionLayout,
  orientation: OrientationController | undefined,
): Promise<Exclude<OrientationLockState, "idle">> {
  if (!orientation?.lock) return "manual";
  try {
    await orientation.lock(requiredProjectionOrientation(layout));
    return "locked";
  } catch {
    return "manual";
  }
}

export function unlockProjectionOrientation(orientation: OrientationController | undefined): void {
  try {
    orientation?.unlock?.();
  } catch {
    // Unlocking is best effort when a browser already released the lock.
  }
}

/**
 * Serialises Screen Orientation API calls and publishes only the newest
 * request. Browsers may reject a superseded lock or resolve it after a newer
 * layout/exit request; both cases must leave the latest intent authoritative.
 */
export function createProjectionOrientationLock(
  orientation: OrientationController | undefined,
  onState: (state: OrientationLockState) => void,
): ProjectionOrientationLock {
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();

  const invalidate = (publishIdle: boolean): void => {
    generation += 1;
    unlockProjectionOrientation(orientation);
    if (publishIdle) onState("idle");
  };

  return {
    lock(layout) {
      const requestGeneration = ++generation;
      const request = queue.then(async () => {
        if (requestGeneration !== generation) return;
        const state = await lockProjectionOrientation(layout, orientation);
        if (requestGeneration !== generation) {
          // A successful obsolete request can acquire the physical lock after
          // an exit or layout change. Release it before the queued winner runs.
          if (state === "locked") unlockProjectionOrientation(orientation);
          return;
        }
        onState(state);
      });
      queue = request.catch(() => undefined);
      return request;
    },
    release() {
      invalidate(true);
    },
    cancel() {
      // Used by React cleanup: invalidate pending work without setState.
      invalidate(false);
    },
  };
}

export function loadProjectionLayout(storage: Pick<Storage, "getItem"> | undefined): ProjectionLayout {
  try {
    const stored = storage?.getItem(PROJECTION_LAYOUT_KEY);
    return stored === "pyramid" || stored === "vee" || stored === "single" ? stored : "pyramid";
  } catch {
    return "pyramid";
  }
}

export function saveProjectionLayout(storage: Pick<Storage, "setItem"> | undefined, layout: ProjectionLayout): void {
  try {
    storage?.setItem(PROJECTION_LAYOUT_KEY, layout);
  } catch {
    // Projection remains usable when private browsing blocks storage.
  }
}
