export const FPS = 30
export const INTRO_FRAMES = 72
// Each feature gets 2.8 seconds parked on its node, followed by the existing
// 0.9-second graph traversal. This adds one readable second per demo without
// making the camera movement itself feel slower.
export const FEATURE_FRAMES = 111
export const FEATURE_COUNT = 7
export const TRAVEL_FRAMES = 27
// After the CTA, URL, sentence, and emoji have all appeared, keep the fully
// static end card visible for 13 more seconds before the feed advances.
export const OUTRO_REVEAL_FRAMES = 190
export const FINAL_HOLD_FRAMES = 13 * FPS
export const OUTRO_FRAMES = OUTRO_REVEAL_FRAMES + FINAL_HOLD_FRAMES
export const DURATION_IN_FRAMES = INTRO_FRAMES + FEATURE_FRAMES * FEATURE_COUNT + OUTRO_FRAMES

export const featureStart = (index: number) => INTRO_FRAMES + index * FEATURE_FRAMES
export const OUTRO_START = featureStart(FEATURE_COUNT)
