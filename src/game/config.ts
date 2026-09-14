/** Every tunable number for Tiny Road Hopper lives here.
 *  Distances are in tiles, times in seconds. */

/** Playfield spans columns -HALF_COLS .. +HALF_COLS inclusive. */
export const HALF_COLS = 6;
/** Traffic and rivers repeat with this world period, so streams are infinite
 *  with a single scalar phase per row instead of a spawner. Must comfortably
 *  exceed the visible width (2*HALF_COLS+1 = 13) so vehicles enter offscreen. */
export const LANE_PERIOD = 26;

export const HOP_TIME = 0.13;
/** A move pressed during a hop is only remembered once the hop is this far
 *  through. Earlier than that the press is dropped, because a hop lasts
 *  HOP_TIME and a move banked at t=0 would fire a full hop later - long enough
 *  for a car to arrive in the meantime, which reads as the game moving you into
 *  traffic by itself. Raising this drops more presses; lowering it queues
 *  staler ones. */
export const BUFFER_FROM = 0.5;
export const HOP_HEIGHT = 0.55;
export const PLAYER_W = 0.72;

/** How far the hopper may fall behind the advancing frontier before it is caught. */
export const BEHIND_LIMIT = 5;
export const CREEP_BASE = 0.5;
export const CREEP_PER_ROW = 0.0055;
export const CREEP_MAX = 2.3;
/** Rows kept generated ahead of / behind the frontier. */
export const AHEAD_ROWS = 26;
export const KEEP_BEHIND = 8;
/** Safe rows at the start of a run so the player is never killed on spawn. */
export const SAFE_START_ROWS = 3;

export const TRAIN_WARN = 1.45;
export const TRAIN_W = 17;
export const TRAIN_SPEED = 26;
export const TRAIN_IDLE_MIN = 1.6;
export const TRAIN_IDLE_MAX = 4.2;

export const COIN_BONUS = 3;
