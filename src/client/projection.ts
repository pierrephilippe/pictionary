/**
 * The projection is rendered on the two reflective faces of a V support.
 * Rotations stay fixed so portrait and landscape viewports share the same
 * composition; CSS is responsible only for scaling the stage to fit.
 */
export const VEE_FACE_ROTATIONS = [90, 270] as const;
