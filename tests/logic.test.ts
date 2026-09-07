import { describe, expect, it } from 'vitest';
import {
  applyAction, canEnter, createState, difficulty, ensureRows, logUnder, moverX,
  rowAt, slack, startRun, step, wrap,
} from '../src/game/logic';
import {
  BEHIND_LIMIT, COIN_BONUS, HALF_COLS, HOP_TIME, LANE_PERIOD, PLAYER_W,
  SAFE_START_ROWS, TRAIN_W, TRAIN_WARN,
} from '../src/game/config';
import type { Action, GameEvent, GameState, Row } from '../src/game/types';

const DT = 1 / 120;

function run(s: GameState, seconds: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (let t = 0; t < seconds; t += DT) out.push(...step(s, DT));
  return out;
}
/** Finish the hop that is currently in flight. */
function settle(s: GameState): GameEvent[] {
  return run(s, HOP_TIME * 1.4);
}
function fresh(seed = 7): GameState {
  const s = createState(seed);
  startRun(s);
  return s;
}
/** Turn a row into a guaranteed-safe patch of grass. */
function pave(row: Row): Row {
  row.kind = 'grass';
  row.movers = [];
  row.blockers = [];
  row.coinCol = null;
  row.train = 'idle';
  row.speed = 0;
  return row;
}
function paveAll(s: GameState): void {
  for (const r of s.rows) pave(r);
}
function hop(s: GameState, a: Action): GameEvent[] {
  const out = applyAction(s, a);
  out.push(...settle(s));
  return out;
}

describe('stream maths', () => {
  it('wraps positions into a single period centred on zero', () => {
    expect(wrap(0)).toBe(0);
    expect(wrap(LANE_PERIOD)).toBeCloseTo(0);
    expect(wrap(LANE_PERIOD / 2)).toBeCloseTo(-LANE_PERIOD / 2);
    for (const v of [-99.5, -3, 0.25, 12, 47.75]) {
      const w = wrap(v);
      expect(w).toBeGreaterThanOrEqual(-LANE_PERIOD / 2);
      expect(w).toBeLessThan(LANE_PERIOD / 2);
      expect(Math.abs(((w - v) % LANE_PERIOD + LANE_PERIOD) % LANE_PERIOD)).toBeLessThan(1e-9);
    }
  });

  it('scrolls movers in the row direction and keeps them on the period', () => {
    const s = fresh();
    // Row 5, not the hopper's row: a car parked on the player would end the run
    // after a single tick and freeze the very stream under test.
    const row = rowAt(s, 5)!;
    row.kind = 'road';
    row.dir = 1;
    row.speed = 4;
    row.phase = 0;
    row.movers = [{ p: 0, w: 1.7, kind: 'car', tint: 0 }];
    const before = moverX(row, row.movers[0]!);
    run(s, 0.5);
    const after = moverX(row, row.movers[0]!);
    expect(after).toBeGreaterThan(before);
    expect(Math.abs(after)).toBeLessThanOrEqual(LANE_PERIOD / 2);
    row.dir = -1;
    const back = moverX(row, row.movers[0]!);
    run(s, 0.5);
    expect(s.phase).toBe('playing');
    expect(moverX(row, row.movers[0]!)).toBeLessThan(back);
  });

  it('scales difficulty from 0 to a hard ceiling of 1', () => {
    expect(difficulty(0)).toBe(0);
    expect(difficulty(75)).toBeCloseTo(0.5);
    expect(difficulty(10_000)).toBe(1);
  });
});

describe('row generation', () => {
  it('keeps the opening rows safe so the run cannot start in traffic', () => {
    for (let seed = 1; seed < 40; seed++) {
      const s = createState(seed);
      for (let i = 0; i <= SAFE_START_ROWS; i++) {
        const row = rowAt(s, i)!;
        expect(row.kind).toBe('grass');
        expect(row.blockers).toHaveLength(0);
      }
    }
  });

  it('never seals a grass row and always leaves a river crossable', () => {
    for (let seed = 1; seed < 25; seed++) {
      const s = createState(seed);
      run(Object.assign(s, { phase: 'playing' as const }), 0.2);
      for (let i = 0; i < 120; i++) {
        s.player.row = i;
        ensureRows(s);
        const row = rowAt(s, i)!;
        if (row.kind === 'grass') {
          const free = [];
          for (let c = -HALF_COLS; c <= HALF_COLS; c++) if (canEnter(s, c, i)) free.push(c);
          expect(free.length).toBeGreaterThanOrEqual(HALF_COLS + 1);
          // No wall of three adjacent blockers.
          const cols = row.blockers.map((b) => b.col).sort((a, b) => a - b);
          for (let k = 2; k < cols.length; k++) {
            expect(cols[k]! - cols[k - 2]!).toBeGreaterThan(2);
          }
        }
        if (row.kind === 'river') expect(row.movers.length).toBeGreaterThanOrEqual(2);
        if (row.kind === 'road') expect(row.movers.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('generates ahead of the player and recycles rows behind', () => {
    const s = fresh();
    const firstBefore = s.firstRow;
    s.player.row = 300;
    s.maxRow = 300;
    s.frontier = 295;
    ensureRows(s);
    expect(rowAt(s, 320)).toBeDefined();
    expect(s.firstRow).toBeGreaterThan(firstBefore);
    expect(rowAt(s, s.firstRow)).toBeDefined();
    // Rows stay contiguous and correctly indexed after the splice.
    s.rows.forEach((r, i) => expect(r.index).toBe(s.firstRow + i));
    expect(s.rows.length).toBeLessThan(60);
  });

  it('produces all four row kinds over a long run', () => {
    const s = createState(3);
    const kinds = new Set<string>();
    for (let i = 0; i < 400; i++) {
      s.player.row = i;
      ensureRows(s);
      kinds.add(rowAt(s, i)!.kind);
    }
    expect([...kinds].sort()).toEqual(['grass', 'rail', 'river', 'road']);
  });
});

describe('hopping', () => {
  it('moves one tile per hop in the pressed direction', () => {
    const s = fresh();
    paveAll(s);
    hop(s, 'up');
    expect(s.player.row).toBe(1);
    expect(s.player.x).toBeCloseTo(0);
    hop(s, 'right');
    expect(s.player.x).toBeCloseTo(1);
    expect(s.player.row).toBe(1);
    hop(s, 'left');
    hop(s, 'left');
    expect(s.player.x).toBeCloseTo(-1);
    hop(s, 'down');
    expect(s.player.row).toBe(0);
    expect(s.hops).toBe(5);
  });

  it('commits to the destination row only at the apex', () => {
    const s = fresh();
    paveAll(s);
    applyAction(s, 'up');
    run(s, HOP_TIME * 0.3);
    expect(s.player.row).toBe(0);
    expect(s.player.hop).not.toBeNull();
    run(s, HOP_TIME * 0.35);
    expect(s.player.row).toBe(1);
    settle(s);
    expect(s.player.hop).toBeNull();
  });

  it('refuses the field edge and static scenery with a bump, not a move', () => {
    const s = fresh();
    paveAll(s);
    s.player.x = HALF_COLS;
    const edge = applyAction(s, 'right');
    expect(edge.map((e) => e.type)).toContain('bump');
    settle(s);
    expect(s.player.x).toBe(HALF_COLS);

    rowAt(s, 1)!.blockers = [{ col: HALF_COLS, kind: 'tree', size: 1 }];
    expect(canEnter(s, HALF_COLS, 1)).toBe(false);
    const tree = applyAction(s, 'up');
    expect(tree.map((e) => e.type)).toContain('bump');
    settle(s);
    expect(s.player.row).toBe(0);
    expect(s.hops).toBe(0);
  });

  it('buffers exactly one hop while airborne and then plays it', () => {
    const s = fresh();
    paveAll(s);
    applyAction(s, 'up');
    applyAction(s, 'up');
    applyAction(s, 'right');
    expect(s.queued).toBe('right');
    expect(s.player.hop!.toRow).toBe(1);
    settle(s);
    expect(s.player.row).toBe(1);
    settle(s);
    expect(s.player.x).toBeCloseTo(1);
    expect(s.player.row).toBe(1);
    expect(s.queued).toBeNull();
  });

  it('ignores input outside the playing phase', () => {
    const s = createState(5);
    expect(applyAction(s, 'up')).toEqual([]);
    expect(s.player.row).toBe(0);
    startRun(s);
    paveAll(s);
    s.phase = 'paused';
    expect(applyAction(s, 'up')).toEqual([]);
    expect(s.player.row).toBe(0);
  });
});

describe('hazards', () => {
  it('kills the hopper when a car overlaps it, and spares a clear lane', () => {
    const s = fresh();
    paveAll(s);
    const row = pave(rowAt(s, 1)!);
    row.kind = 'road';
    row.speed = 0;
    row.phase = 0;
    row.dir = 1;
    row.movers = [{ p: 4, w: 1.7, kind: 'car', tint: 0 }];
    hop(s, 'up');
    run(s, 0.3);
    expect(s.phase).toBe('playing');

    row.movers = [{ p: 0.2, w: 1.7, kind: 'car', tint: 0 }];
    const events = run(s, 0.1);
    expect(s.phase).toBe('over');
    expect(s.cause).toMatch(/car/);
    expect(events.some((e) => e.type === 'over')).toBe(true);
  });

  it('uses vehicle width for the hit box', () => {
    const near = PLAYER_W / 2 + 3.2 / 2 - 0.05;
    const far = PLAYER_W / 2 + 3.2 / 2 + 0.2;
    for (const [dx, dead] of [[near, true], [far, false]] as const) {
      const s = fresh();
      paveAll(s);
      const row = pave(rowAt(s, 0)!);
      row.kind = 'road';
      row.speed = 0;
      row.phase = 0;
      row.dir = 1;
      row.movers = [{ p: dx, w: 3.2, kind: 'truck', tint: 0 }];
      run(s, 0.05);
      expect(s.phase === 'over').toBe(dead);
      if (dead) expect(s.cause).toMatch(/truck/);
    }
  });

  it('drowns a hopper that lands on open water', () => {
    const s = fresh();
    paveAll(s);
    const row = pave(rowAt(s, 1)!);
    row.kind = 'river';
    row.speed = 1;
    row.dir = 1;
    row.phase = 0;
    row.movers = [{ p: 9, w: 3, kind: 'log', tint: 0 }];
    expect(logUnder(row, 0)).toBe(-1);
    hop(s, 'up');
    expect(s.phase).toBe('over');
    expect(s.cause).toMatch(/river/);
  });

  it('carries the hopper on a log and only sweeps it off at the edge', () => {
    const s = fresh();
    paveAll(s);
    const row = pave(rowAt(s, 1)!);
    row.kind = 'river';
    row.speed = 2;
    row.dir = 1;
    row.phase = 0;
    row.movers = [{ p: 0, w: 4, kind: 'log', tint: 0 }];
    const events = hop(s, 'up');
    expect(s.phase).toBe('playing');
    expect(events.some((e) => e.type === 'board')).toBe(true);
    expect(s.player.ridingLog).toBe(0);
    const x0 = s.player.x;
    run(s, 0.5);
    // Rider drifts with the platform, and the platform drifts under it.
    expect(s.player.x).toBeGreaterThan(x0);
    expect(Math.abs(s.player.x - moverX(row, row.movers[0]!))).toBeLessThan(row.movers[0]!.w / 2);
    run(s, 6);
    expect(s.phase).toBe('over');
    expect(s.cause).toMatch(/swept/);
  });

  it('lets the hopper leave a moving log by hopping', () => {
    const s = fresh();
    paveAll(s);
    const river = pave(rowAt(s, 1)!);
    river.kind = 'river';
    river.speed = 2;
    river.dir = 1;
    river.phase = 0;
    river.movers = [{ p: 0, w: 5, kind: 'log', tint: 0 }];
    hop(s, 'up');
    run(s, 0.4);
    expect(s.player.x).not.toBeCloseTo(0);
    hop(s, 'up');
    expect(s.player.row).toBe(2);
    expect(s.phase).toBe('playing');
    // Hopping off a log lands on a whole column again.
    expect(s.player.x).toBeCloseTo(Math.round(s.player.x));
  });

  it('runs the train state machine: idle -> warn -> passing, then kills', () => {
    const s = fresh();
    paveAll(s);
    const row = pave(rowAt(s, 0)!);
    row.kind = 'rail';
    row.dir = 1;
    row.trainTimer = 0.05;
    row.train = 'idle';
    const warn = run(s, 0.1);
    expect(row.train).toBe('warn');
    expect(warn.some((e) => e.type === 'train-warn')).toBe(true);
    expect(s.phase).toBe('playing');
    // The warning is a real grace period, not decoration.
    run(s, TRAIN_WARN * 0.6);
    expect(s.phase).toBe('playing');
    expect(row.trainX).toBeLessThan(-HALF_COLS);
    run(s, TRAIN_WARN);
    expect(row.train).toBe('passing');
    run(s, (HALF_COLS + TRAIN_W / 2) / 26 + 0.05);
    expect(s.phase).toBe('over');
    expect(s.cause).toMatch(/tracks/);
  });

  it('lets a train pass harmlessly when the hopper is off the rail', () => {
    const s = fresh();
    paveAll(s);
    const row = pave(rowAt(s, 1)!);
    row.kind = 'rail';
    row.dir = 1;
    row.train = 'passing';
    row.trainX = 0;
    run(s, 1.5);
    expect(s.phase).toBe('playing');
    expect(row.train).toBe('idle');
  });
});

describe('frontier and scoring', () => {
  it('scores the furthest row reached plus a coin bonus', () => {
    const s = fresh();
    paveAll(s);
    for (let i = 0; i < 4; i++) hop(s, 'up');
    expect(s.maxRow).toBe(4);
    expect(s.score).toBe(4);
    // Going back does not reduce the score.
    hop(s, 'down');
    expect(s.player.row).toBe(3);
    expect(s.maxRow).toBe(4);
    expect(s.score).toBe(4);
    const row = pave(rowAt(s, 3)!);
    row.coinCol = Math.round(s.player.x);
    const events = run(s, 0.05);
    expect(events.some((e) => e.type === 'coin')).toBe(true);
    expect(s.coins).toBe(1);
    expect(s.score).toBe(4 + COIN_BONUS);
    // A collected coin cannot be farmed twice.
    run(s, 0.2);
    expect(s.coins).toBe(1);
  });

  it('advances the frontier and catches a hopper that stalls', () => {
    const s = fresh();
    paveAll(s);
    const f0 = s.frontier;
    run(s, 1);
    expect(s.frontier).toBeGreaterThan(f0);
    expect(slack(s)).toBeLessThan(BEHIND_LIMIT + 1);
    const events = run(s, 40);
    expect(s.phase).toBe('over');
    expect(s.cause).toMatch(/hawk/);
    expect(events.filter((e) => e.type === 'over')).toHaveLength(1);
  });

  it('never lets the frontier trail further than the limit behind the record', () => {
    const s = fresh();
    paveAll(s);
    s.maxRow = 200;
    s.player.row = 200;
    run(s, 0.1);
    expect(s.frontier).toBeGreaterThanOrEqual(200 - BEHIND_LIMIT);
    expect(s.frontier).toBeLessThan(200);
  });

  it('freezes the world once the run is over', () => {
    const s = fresh();
    paveAll(s);
    s.phase = 'over';
    const snapshot = JSON.stringify({ p: s.player, f: s.frontier, t: s.time });
    expect(run(s, 2)).toEqual([]);
    expect(JSON.stringify({ p: s.player, f: s.frontier, t: s.time })).toBe(snapshot);
  });

  it('resets everything for a new run', () => {
    const s = fresh();
    paveAll(s);
    for (let i = 0; i < 3; i++) hop(s, 'up');
    s.coins = 5;
    s.phase = 'over';
    const n = createState(11);
    startRun(n);
    expect(n.phase).toBe('playing');
    expect(n.player).toEqual({ x: 0, row: 0, hop: null, face: 'up', ridingLog: -1 });
    expect([n.maxRow, n.coins, n.score, n.hops, n.time, n.cause]).toEqual([0, 0, 0, 0, 0, null]);
    expect(n.frontier).toBe(-BEHIND_LIMIT);
  });

  it('is deterministic for a seed and different across seeds', () => {
    const kinds = (seed: number) => {
      const s = createState(seed);
      return s.rows.slice(0, 24).map((r) => r.kind).join('');
    };
    expect(kinds(42)).toBe(kinds(42));
    expect(kinds(42)).not.toBe(kinds(43));
  });

  it('survives a long unattended simulation without throwing or leaking rows', () => {
    const s = fresh(99);
    for (let i = 0; i < 6000; i++) {
      step(s, DT);
      if (s.phase === 'playing' && i % 12 === 0) {
        // Walk forward whenever the next row is enterable, else shuffle sideways.
        const col = Math.round(s.player.x);
        applyAction(s, canEnter(s, col, s.player.row + 1) ? 'up' : 'right');
      }
      if (s.phase === 'over') {
        startRun(s);
        s.player.row = Math.ceil(s.frontier) + 1;
      }
    }
    expect(s.rows.length).toBeLessThan(80);
    expect(s.maxRow).toBeGreaterThan(3);
    expect(Number.isFinite(s.player.x)).toBe(true);
  });
});
