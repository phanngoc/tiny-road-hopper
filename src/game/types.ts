export type RowKind = 'grass' | 'road' | 'river' | 'rail';
/** A themed stretch of rows. Purely a generation bias: every theme still goes
 *  through the same reachability rules, so no theme can seal the field. */
export type Theme = 'meadow' | 'highway' | 'riverlands' | 'crossing';
export type Action = 'up' | 'down' | 'left' | 'right';
export type Phase = 'menu' | 'playing' | 'paused' | 'over';
export type TrainState = 'idle' | 'warn' | 'passing';

/** A vehicle or a floating platform. `p` is its position inside the row's
 *  repeating period; the live world x is wrap(p + row.phase). */
export interface Mover {
  p: number;
  w: number;
  /** Cosmetic sub-type: cars/trucks on roads, logs/pads on rivers. */
  kind: 'car' | 'truck' | 'log' | 'pad';
  tint: number;
}

export interface Blocker {
  col: number;
  kind: 'tree' | 'rock' | 'bush';
  size: number;
}

export interface Row {
  index: number;
  kind: RowKind;
  /** -1 left, +1 right. Unused on grass. */
  dir: -1 | 1;
  /** Tiles per second for movers, 0 on grass. */
  speed: number;
  /** Accumulated scroll of this row's stream. */
  phase: number;
  movers: Mover[];
  blockers: Blocker[];
  coinCol: number | null;
  coinTaken: boolean;
  train: TrainState;
  trainTimer: number;
  trainX: number;
  variant: number;
}

export interface Hop {
  fromX: number;
  fromRow: number;
  toX: number;
  toRow: number;
  /** 0 at take-off, 1 on landing. */
  t: number;
  /** Set when the move was refused: play the bump, do not move. */
  bump: boolean;
}

export interface Player {
  /** Float: riding a log drifts the hopper between columns. */
  x: number;
  row: number;
  hop: Hop | null;
  /** Facing, used by the renderer only. */
  face: Action;
  /** Index into row.movers of the log being ridden, -1 when on land. */
  ridingLog: number;
}

export interface GameState {
  phase: Phase;
  player: Player;
  rows: Row[];
  /** rows[0].index; rows are contiguous from here. */
  firstRow: number;
  /** The advancing line the hopper must stay ahead of. */
  frontier: number;
  maxRow: number;
  coins: number;
  score: number;
  hops: number;
  time: number;
  cause: string | null;
  queued: Action | null;
  /** Current themed segment and how many more rows it covers. */
  theme: Theme;
  themeLeft: number;
  /** Next short distance goal, in rows. Optional flavour: missing it costs
   *  nothing, so there is no streak to protect and nothing to buy. */
  goal: number;
  goalsMet: number;
  rng: number;
}

export type GameEvent =
  | { type: 'hop' }
  | { type: 'bump' }
  | { type: 'coin'; total: number }
  | { type: 'milestone'; row: number }
  | { type: 'goal'; row: number; total: number }
  | { type: 'theme'; theme: Theme }
  | { type: 'train-warn' }
  | { type: 'board'; kind: 'log' | 'pad' }
  | { type: 'over'; cause: string };
