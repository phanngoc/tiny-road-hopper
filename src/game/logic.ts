/** The whole simulation: pure, deterministic, DOM-free and clock-free, so the
 *  unit tests drive it exactly like the browser does. */
import {
  AHEAD_ROWS, BEHIND_LIMIT, COIN_BONUS, CREEP_BASE, CREEP_MAX, CREEP_PER_ROW,
  HALF_COLS, HOP_TIME, KEEP_BEHIND, LANE_PERIOD, PLAYER_W, SAFE_START_ROWS,
  TRAIN_IDLE_MAX, TRAIN_IDLE_MIN, TRAIN_SPEED, TRAIN_W, TRAIN_WARN,
} from './config';
import type { Action, GameEvent, GameState, Mover, Row, RowKind } from './types';

/* ------------------------------------------------------------------ random */

/** Mulberry32: small, fast, and identical across runs for a given seed. */
function nextRandom(state: { rng: number }): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rand = (s: GameState, a: number, b: number): number => a + nextRandom(s) * (b - a);
const randInt = (s: GameState, a: number, b: number): number => Math.floor(rand(s, a, b + 1 - 1e-9));
const pick = <T>(s: GameState, xs: readonly T[]): T => xs[randInt(s, 0, xs.length - 1)]!;

/** Fold a stream position into [-LANE_PERIOD/2, LANE_PERIOD/2). */
export function wrap(v: number): number {
  const h = LANE_PERIOD / 2;
  return ((((v + h) % LANE_PERIOD) + LANE_PERIOD) % LANE_PERIOD) - h;
}

/** Live world x of a mover on a row. */
export function moverX(row: Row, m: Mover): number {
  return wrap(m.p + row.phase);
}

/* ------------------------------------------------------------ generation */

/** Difficulty in 0..1, driven by how far the run has got. */
export function difficulty(maxRow: number): number {
  return Math.min(1, maxRow / 150);
}

function chooseKind(s: GameState, prev: Row | undefined, index: number): RowKind {
  if (index <= SAFE_START_ROWS) return 'grass';
  const d = difficulty(index);
  // A river band always ends on land: never place a river directly after a
  // river's last row without a breather, and never a rail right after a river.
  const prevKind = prev?.kind ?? 'grass';
  if (prevKind === 'river' && nextRandom(s) < 0.45) return 'grass';
  if (prevKind === 'rail') return 'grass';
  // Continue a road or river band so traffic reads as multi-lane.
  if ((prevKind === 'road' || prevKind === 'river') && nextRandom(s) < 0.5 + d * 0.18) return prevKind;
  const r = nextRandom(s);
  const grassShare = 0.42 - d * 0.16;
  const roadShare = grassShare + 0.34 + d * 0.04;
  const riverShare = roadShare + 0.16 + d * 0.05;
  if (r < grassShare) return 'grass';
  if (r < roadShare) return 'road';
  if (r < riverShare) return 'river';
  return 'rail';
}

function fillStream(s: GameState, movers: Mover[], widths: readonly number[], kinds: readonly Mover['kind'][], gapMin: number, gapMax: number): void {
  // Walk once round the period laying movers down with random gaps, then drop
  // the last one if it would touch the first: the stream has to stay periodic.
  let p = rand(s, 0, LANE_PERIOD);
  const start = p;
  let guard = 0;
  while (guard++ < 40) {
    const w = pick(s, widths);
    const gap = rand(s, gapMin, gapMax);
    if (p + w / 2 + gap - start > LANE_PERIOD) break;
    movers.push({ p: wrap(p + w / 2), w, kind: pick(s, kinds), tint: nextRandom(s) });
    p += w + gap;
  }
}

function makeRow(s: GameState, index: number, prev: Row | undefined): Row {
  const kind = chooseKind(s, prev, index);
  const d = difficulty(index);
  const row: Row = {
    index, kind, dir: nextRandom(s) < 0.5 ? -1 : 1, speed: 0, phase: rand(s, 0, LANE_PERIOD),
    movers: [], blockers: [], coinCol: null, coinTaken: false,
    train: 'idle', trainTimer: 0, trainX: 0, variant: nextRandom(s),
  };
  // Rows inside a band share a direction alternation so lanes read clearly.
  if (prev && prev.kind === kind && (kind === 'road' || kind === 'river')) row.dir = prev.dir === 1 ? -1 : 1;

  if (kind === 'road') {
    row.speed = rand(s, 2.4, 4.6) + d * 3.2;
    // Faster lanes need bigger holes or they become unfair.
    const gapMin = 2.5 + row.speed * 0.34;
    fillStream(s, row.movers, [1.7, 1.7, 1.7, 3.2], ['car', 'car', 'car', 'truck'], gapMin, gapMin + rand(s, 2.4, 6.5));
  } else if (kind === 'river') {
    row.speed = rand(s, 1.5, 2.9) + d * 1.5;
    fillStream(s, row.movers, [2.4, 3.4, 4.2, 1.5], ['log', 'log', 'log', 'pad'], 1.3, 3.1);
    // A river row with no platform at all is a wall, not a puzzle.
    if (row.movers.length < 2) fillStream(s, row.movers, [3.4], ['log'], 1.6, 2.6);
  } else if (kind === 'rail') {
    row.speed = TRAIN_SPEED;
    row.trainTimer = rand(s, TRAIN_IDLE_MIN, TRAIN_IDLE_MAX);
    row.trainX = -HALF_COLS - TRAIN_W;
  } else {
    // Grass: scatter blockers but never more than three in a row and never
    // enough to seal the field, so a route always exists.
    const count = index <= SAFE_START_ROWS ? 0 : randInt(s, 0, 3 + Math.round(d * 2));
    for (let i = 0; i < count; i++) {
      const col = randInt(s, -HALF_COLS, HALF_COLS);
      if (row.blockers.some((b) => b.col === col)) continue;
      row.blockers.push({ col, kind: pick(s, ['tree', 'tree', 'rock', 'bush'] as const), size: rand(s, 0.75, 1.15) });
    }
    // Three adjacent blockers would be a wall the hopper has to detour around
    // while the hawk closes in, so break every run of three by its middle.
    row.blockers.sort((a, b) => a.col - b.col);
    for (let i = 2; i < row.blockers.length; i++) {
      if (row.blockers[i]!.col - row.blockers[i - 2]!.col === 2) {
        row.blockers.splice(i - 1, 1);
        i--;
      }
    }
    if (index > SAFE_START_ROWS && nextRandom(s) < 0.3) {
      const free = [];
      for (let c = -HALF_COLS; c <= HALF_COLS; c++) if (!row.blockers.some((b) => b.col === c)) free.push(c);
      if (free.length) row.coinCol = free[randInt(s, 0, free.length - 1)]!;
    }
  }
  return row;
}

export function rowAt(s: GameState, index: number): Row | undefined {
  return s.rows[index - s.firstRow];
}

/** Generate forward to cover the view and drop rows that fell out of it. */
export function ensureRows(s: GameState): void {
  const target = Math.ceil(Math.max(s.frontier, s.player.row) + AHEAD_ROWS);
  while (s.firstRow + s.rows.length <= target) {
    const index = s.firstRow + s.rows.length;
    s.rows.push(makeRow(s, index, s.rows[s.rows.length - 1]));
  }
  const cut = Math.floor(Math.min(s.frontier, s.player.row)) - KEEP_BEHIND - s.firstRow;
  if (cut > 0) {
    s.rows.splice(0, cut);
    s.firstRow += cut;
  }
}

/* --------------------------------------------------------------- lifecycle */

export function createState(seed: number): GameState {
  const s: GameState = {
    phase: 'menu',
    player: { x: 0, row: 0, hop: null, face: 'up', ridingLog: -1 },
    // Start with ground already generated BEHIND row 0: without it the strip of
    // screen below the hopper has no rows to draw and shows through as a chasm.
    rows: [], firstRow: -KEEP_BEHIND, frontier: -BEHIND_LIMIT, maxRow: 0,
    coins: 0, score: 0, hops: 0, time: 0, cause: null, queued: null,
    rng: (seed | 0) || 1,
  };
  ensureRows(s);
  return s;
}

export function startRun(s: GameState): void {
  s.phase = 'playing';
  s.cause = null;
}

function over(s: GameState, cause: string, out: GameEvent[]): void {
  if (s.phase === 'over') return;
  s.phase = 'over';
  s.cause = cause;
  s.player.hop = null;
  out.push({ type: 'over', cause });
}

/* ------------------------------------------------------------------- input */

/** Is the target cell walkable? Water and traffic are survivable-in-principle,
 *  so only static scenery and the field edge refuse a hop. */
export function canEnter(s: GameState, col: number, row: number): boolean {
  if (col < -HALF_COLS || col > HALF_COLS) return false;
  if (row < s.firstRow) return false;
  const r = rowAt(s, row);
  if (!r) return false;
  return !r.blockers.some((b) => b.col === col);
}

/** Is landing at (col, row) an instant kill right now? Only consulted for a
 *  move that was buffered during a hop: the player chose it before this hazard
 *  existed, so playing it unchanged would be the game stepping them into
 *  traffic they never saw. A move pressed directly is still the player's own
 *  call and is never second-guessed. */
function lethalNow(s: GameState, col: number, row: number): boolean {
  const r = rowAt(s, row);
  if (!r) return false;
  if (r.kind === 'road') {
    return r.movers.some((m) => Math.abs(col - moverX(r, m)) < (m.w + PLAYER_W) / 2);
  }
  if (r.kind === 'rail') {
    return r.train === 'passing' && Math.abs(col - r.trainX) < (TRAIN_W + PLAYER_W) / 2;
  }
  return false;
}

export function applyAction(s: GameState, a: Action, buffered = false): GameEvent[] {
  const out: GameEvent[] = [];
  if (s.phase !== 'playing') return out;
  const p = s.player;
  // One buffered move keeps fast taps feeling responsive without letting the
  // player bank a queue of hops. The whole hop can buffer, so a deliberate fast
  // sequence is never swallowed; fairness is enforced when the move is played
  // instead, by `buffered` below.
  if (p.hop && p.hop.t < 1) {
    s.queued = a;
    return out;
  }
  const fromCol = Math.round(p.x);
  let col = fromCol;
  let row = p.row;
  if (a === 'up') row += 1;
  else if (a === 'down') row -= 1;
  else if (a === 'left') col -= 1;
  else col += 1;
  p.face = a;
  if (!canEnter(s, col, row) || (buffered && lethalNow(s, col, row))) {
    p.hop = { fromX: p.x, fromRow: p.row, toX: p.x, toRow: p.row, t: 0, bump: true };
    out.push({ type: 'bump' });
    return out;
  }
  p.hop = { fromX: p.x, fromRow: p.row, toX: col, toRow: row, t: 0, bump: false };
  p.ridingLog = -1;
  s.hops++;
  out.push({ type: 'hop' });
  return out;
}

/* -------------------------------------------------------------------- step */

function stepRow(s: GameState, row: Row, dt: number, out: GameEvent[], playerRow: number): void {
  if (row.kind === 'road' || row.kind === 'river') {
    // Signed accumulation: flipping row.dir must reverse travel from the movers'
    // current positions, not mirror the whole stream about zero.
    row.phase = (row.phase + row.dir * row.speed * dt) % LANE_PERIOD;
    return;
  }
  if (row.kind !== 'rail') return;
  row.trainTimer -= dt;
  if (row.train === 'idle' && row.trainTimer <= 0) {
    row.train = 'warn';
    row.trainTimer = TRAIN_WARN;
    row.trainX = row.dir === 1 ? -HALF_COLS - TRAIN_W / 2 - 2 : HALF_COLS + TRAIN_W / 2 + 2;
    // Only announce trains the player can actually see coming for themselves.
    if (Math.abs(row.index - playerRow) <= 8) out.push({ type: 'train-warn' });
  } else if (row.train === 'warn' && row.trainTimer <= 0) {
    row.train = 'passing';
    row.trainTimer = 0;
  } else if (row.train === 'passing') {
    row.trainX += row.dir * TRAIN_SPEED * dt;
    const done = row.dir === 1 ? row.trainX - TRAIN_W / 2 > HALF_COLS + 2 : row.trainX + TRAIN_W / 2 < -HALF_COLS - 2;
    if (done) {
      row.train = 'idle';
      row.trainTimer = rand(s, TRAIN_IDLE_MIN, TRAIN_IDLE_MAX);
      row.dir = nextRandom(s) < 0.5 ? -1 : 1;
    }
  }
}

/** Index of the platform under x on a river row, or -1. */
export function logUnder(row: Row, x: number): number {
  for (let i = 0; i < row.movers.length; i++) {
    const m = row.movers[i]!;
    if (Math.abs(x - moverX(row, m)) <= m.w / 2 + 0.08) return i;
  }
  return -1;
}

export function step(s: GameState, dt: number): GameEvent[] {
  const out: GameEvent[] = [];
  if (s.phase !== 'playing') return out;
  s.time += dt;
  const p = s.player;

  // 1. Hop animation. The hopper commits to the destination row at the apex,
  //    so it is the new row's hazards that judge it from halfway on.
  if (p.hop) {
    p.hop.t = Math.min(1, p.hop.t + dt / HOP_TIME);
    if (!p.hop.bump) {
      const e = p.hop.t;
      p.x = p.hop.fromX + (p.hop.toX - p.hop.fromX) * e;
      p.row = e >= 0.5 ? p.hop.toRow : p.hop.fromRow;
    }
    if (p.hop.t >= 1) {
      if (!p.hop.bump) {
        p.x = p.hop.toX;
        p.row = p.hop.toRow;
      }
      p.hop = null;
      if (s.queued) {
        const q = s.queued;
        s.queued = null;
        out.push(...applyAction(s, q, true));
      }
    }
  }
  const airborne = p.hop !== null && !p.hop.bump;

  // 2. World: every live row advances its stream, trains included.
  for (const row of s.rows) stepRow(s, row, dt, out, p.row);

  // 3. Frontier creep, then the catch-up rule.
  const creep = Math.min(CREEP_MAX, CREEP_BASE + s.maxRow * CREEP_PER_ROW);
  s.frontier = Math.max(s.frontier + creep * dt, s.maxRow - BEHIND_LIMIT);
  ensureRows(s);

  // 4. Score follows the furthest row reached; coins are a bonus on top.
  if (p.row > s.maxRow) {
    s.maxRow = p.row;
    if (s.maxRow % 25 === 0) out.push({ type: 'milestone', row: s.maxRow });
  }
  s.score = s.maxRow + s.coins * COIN_BONUS;

  const row = rowAt(s, p.row);
  if (!row) return out;

  // 5. Coins.
  if (row.coinCol !== null && !row.coinTaken && !airborne && Math.abs(p.x - row.coinCol) < 0.5) {
    row.coinTaken = true;
    s.coins++;
    s.score = s.maxRow + s.coins * COIN_BONUS;
    out.push({ type: 'coin', total: s.coins });
  }

  // 6. Hazards. Traffic and trains hit mid-hop too; water only drowns you once
  //    you have actually landed on it.
  if (row.kind === 'road') {
    for (const m of row.movers) {
      if (Math.abs(p.x - moverX(row, m)) < (m.w + PLAYER_W) / 2) {
        over(s, m.kind === 'truck' ? 'were run down by a truck' : 'were clipped by a car', out);
        return out;
      }
    }
  } else if (row.kind === 'rail') {
    if (row.train === 'passing' && Math.abs(p.x - row.trainX) < (TRAIN_W + PLAYER_W) / 2) {
      over(s, 'were caught on the tracks by the express', out);
      return out;
    }
  } else if (row.kind === 'river') {
    const idx = logUnder(row, p.x);
    if (idx < 0) {
      if (!airborne) {
        over(s, 'sank in the river', out);
        return out;
      }
      p.ridingLog = -1;
    } else {
      if (p.ridingLog !== idx && !airborne) {
        p.ridingLog = idx;
        out.push({ type: 'board', kind: row.movers[idx]!.kind === 'pad' ? 'pad' : 'log' });
      }
      if (!airborne) {
        // Ride: the platform carries the hopper, and off the edge is fatal.
        p.x += row.dir * row.speed * dt;
        if (Math.abs(p.x) > HALF_COLS + 0.55) {
          over(s, 'were swept off the map by the current', out);
          return out;
        }
      }
    }
  } else {
    p.ridingLog = -1;
  }

  // 7. The frontier.
  if (p.row < s.frontier) {
    over(s, 'fell behind and were snatched by the hawk', out);
    return out;
  }
  return out;
}

/** Rows of slack left before the hawk strikes - drives the HUD warning. */
export function slack(s: GameState): number {
  return s.player.row - s.frontier;
}
