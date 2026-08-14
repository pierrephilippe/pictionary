/**
 * The projection is rendered on the two reflective faces of a V support.
 * The former horizontal composition is rotated 90° clockwise as one unit:
 * its left face becomes the top face and its right face the bottom one.
 * Rotations stay fixed across viewport orientations; CSS only scales it.
 */
export const VEE_FACE_ROTATIONS = [180, 0] as const;
