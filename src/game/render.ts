/** Canvas 2D renderer: an oblique 2.5D board where one grid row is one
 *  horizontal band. Everything is drawn as a chunky two-face box (front + top),
 *  which reads as depth without needing a real 3D pipeline. */
import { BEHIND_LIMIT, HALF_COLS, HOP_HEIGHT, HOP_TIME, LANE_PERIOD, TRAIN_W } from './config';
import { moverX, rowAt, slack } from './logic';
import type { GameState, Mover, Row } from './types';

export interface Viewport {
  w: number;
  h: number;
  dpr: number;
}

const SKY_TOP = '#0f1a2b';
const SKY_BOTTOM = '#27405c';

/** Deterministic per-key jitter so scenery does not shimmer between frames. */
function hash(a: number, b: number): number {
  const t = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return t - Math.floor(t);
}

export class Renderer {
  private camRow = 0;
  private camX = 0;
  private shake = 0;
  private t = 0;
  private started = false;
  /** Screen shake and the throbbing danger vignette are motion for its own
   *  sake, so they are dropped when the OS asks for reduced motion. Nothing
   *  here feeds the simulation, so collision and scoring are unaffected. */
  private reducedMotion = false;

  constructor(private ctx: CanvasRenderingContext2D) {
    const q = matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = q.matches;
    q.addEventListener('change', (e) => {
      this.reducedMotion = e.matches;
      if (this.reducedMotion) this.shake = 0;
    });
  }

  reset(): void {
    this.camRow = 0;
    this.camX = 0;
    this.shake = 0;
    this.started = false;
  }

  kick(power: number): void {
    if (this.reducedMotion) return;
    this.shake = Math.max(this.shake, power);
  }

  private tile(vp: Viewport): number {
    // Width term zooms in on narrow phones; height term keeps a sensible number
    // of rows on screen so the player can read the traffic ahead.
    return Math.max(20, Math.min(vp.w / 9.5, vp.h / 13));
  }

  /** Smoothed camera. Kept out of the simulation so physics stays pure. */
  follow(state: GameState, dt: number, vp: Viewport): void {
    this.t += dt;
    const p = state.player;
    const tile = this.tile(vp);
    // Only pan sideways when the field is wider than the screen, otherwise the
    // hedges would slide off and reveal empty space.
    const panLimit = Math.max(0, HALF_COLS + 1.4 - vp.w / tile / 2);
    const targetX = Math.max(-panLimit, Math.min(panLimit, p.x));
    // Bias the view forward so the hopper sees what it is about to jump into.
    const targetRow = Math.max(p.row + 0.55, state.frontier + BEHIND_LIMIT * 0.45);
    if (!this.started) {
      this.started = true;
      this.camRow = targetRow;
      this.camX = targetX;
    }
    const k = Math.min(1, dt * 11);
    this.camRow += (targetRow - this.camRow) * k;
    this.camX += (targetX - this.camX) * k;
    this.shake = Math.max(0, this.shake - dt * 2.2);
  }

  private rowH(vp: Viewport): number {
    return this.tile(vp) * 0.7;
  }

  draw(state: GameState, vp: Viewport): void {
    const ctx = this.ctx;
    const tile = this.tile(vp);
    const rowH = this.rowH(vp);
    const anchorY = vp.h * 0.76;

    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
    // Clear every frame: translucent glow passes otherwise pile into a smear.
    ctx.clearRect(0, 0, vp.w, vp.h);
    const sky = ctx.createLinearGradient(0, 0, 0, vp.h);
    sky.addColorStop(0, SKY_TOP);
    sky.addColorStop(1, SKY_BOTTOM);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, vp.w, vp.h);

    if (this.shake > 0) {
      const m = this.shake * this.shake * 9;
      ctx.translate(Math.sin(this.t * 71) * m, Math.cos(this.t * 53) * m);
    }

    const sx = (x: number): number => vp.w / 2 + (x - this.camX) * tile;
    const gy = (row: number): number => anchorY - (row - this.camRow) * rowH;

    // gy() maps higher rows to smaller y, so the rows AHEAD fill the screen
    // above the anchor and the rows behind fill the strip below it. Getting
    // these two the wrong way round leaves the board ending in bare sky.
    const last = Math.ceil(this.camRow + anchorY / rowH) + 2;
    const first = Math.floor(this.camRow - (vp.h - anchorY) / rowH) - 2;
    const playerRow = state.player.row;

    // Behind the last generated row the world has already been eaten: draw a
    // chasm so the gap never shows through as raw sky.
    const nearEdge = gy(state.firstRow);
    if (nearEdge < vp.h) {
      const chasm = ctx.createLinearGradient(0, nearEdge, 0, vp.h);
      chasm.addColorStop(0, 'rgba(10,7,16,0.55)');
      chasm.addColorStop(1, 'rgba(6,4,11,0.95)');
      ctx.fillStyle = chasm;
      ctx.fillRect(0, nearEdge, vp.w, vp.h - nearEdge);
    }

    // Far to near, so nearer rows and their traffic overlap the ones behind.
    for (let i = last; i >= first; i--) {
      const row = rowAt(state, i);
      if (!row) continue;
      this.drawBand(row, state, sx, gy, tile, rowH, vp);
      if (i === playerRow) this.drawPlayer(state, sx, gy, tile, rowH);
    }
    // The hopper is drawn with its row; if that row is off the generated range
    // (only possible in the frame it dies) draw it anyway so it never vanishes.
    if (!rowAt(state, playerRow)) this.drawPlayer(state, sx, gy, tile, rowH);

    this.drawTarget(state, sx, gy, tile, rowH);
    this.drawHawk(state, sx, gy, tile, rowH, vp);
    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
    this.drawVignette(state, vp);
  }

  /** Marks the cell the hopper is committed to, so a hop in flight - and a
   *  press buffered behind it - has a visible destination instead of being
   *  something the player only finds out about on landing. */
  private drawTarget(
    state: GameState, sx: (x: number) => number, gy: (r: number) => number,
    tile: number, rowH: number,
  ): void {
    const p = state.player;
    if (state.phase !== 'playing') return;
    const hop = p.hop;
    if (!hop || hop.bump) return;
    const ctx = this.ctx;
    // The live hop's landing cell, then the buffered press's cell beyond it.
    const cells: Array<{ x: number; row: number; strong: boolean }> = [
      { x: hop.toX, row: hop.toRow, strong: true },
    ];
    if (state.queued) {
      const q = state.queued;
      cells.push({
        x: hop.toX + (q === 'left' ? -1 : q === 'right' ? 1 : 0),
        row: hop.toRow + (q === 'up' ? 1 : q === 'down' ? -1 : 0),
        strong: false,
      });
    }
    for (const c of cells) {
      const cx = sx(c.x);
      const cy = gy(c.row) - rowH * 0.18;
      const w = tile * 0.62;
      const h = rowH * 0.34;
      ctx.save();
      ctx.lineWidth = Math.max(1.5, tile * 0.055);
      ctx.strokeStyle = c.strong ? 'rgba(255,255,255,0.85)' : 'rgba(255,215,94,0.75)';
      if (!c.strong) ctx.setLineDash([tile * 0.14, tile * 0.1]);
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.5, h * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* --------------------------------------------------------------- terrain */

  private drawBand(
    row: Row, state: GameState,
    sx: (x: number) => number, gy: (r: number) => number,
    tile: number, rowH: number, vp: Viewport,
  ): void {
    const ctx = this.ctx;
    const yBack = gy(row.index) - rowH;
    const left = sx(-HALF_COLS - 0.5);
    const right = sx(HALF_COLS + 0.5);
    const fieldW = right - left;

    // Ground outside the playfield: hedge rows the hopper cannot enter.
    ctx.fillStyle = row.index % 2 === 0 ? '#1d3a26' : '#1a3422';
    ctx.fillRect(0, yBack, vp.w, rowH + 1);

    if (row.kind === 'grass') {
      const light = row.index % 2 === 0;
      ctx.fillStyle = light ? '#4e9a4e' : '#469044';
      ctx.fillRect(left, yBack, fieldW, rowH + 1);
      ctx.fillStyle = light ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
      ctx.fillRect(left, yBack, fieldW, rowH * 0.34);
    } else if (row.kind === 'road') {
      ctx.fillStyle = '#3a3f47';
      ctx.fillRect(left, yBack, fieldW, rowH + 1);
      const prev = rowAt(state, row.index - 1);
      const next = rowAt(state, row.index + 1);
      ctx.fillStyle = '#f2d06b';
      // Dashes only between two road rows; solid kerbs at the band's edges.
      if (next?.kind === 'road') {
        for (let x = -HALF_COLS - 0.5; x < HALF_COLS + 0.5; x += 1.6) {
          ctx.fillRect(sx(x), yBack, tile * 0.8, Math.max(1.5, rowH * 0.05));
        }
      } else {
        ctx.fillStyle = '#cfd6e0';
        ctx.fillRect(left, yBack, fieldW, Math.max(2, rowH * 0.07));
      }
      if (prev?.kind !== 'road') {
        ctx.fillStyle = '#cfd6e0';
        ctx.fillRect(left, yBack + rowH - Math.max(2, rowH * 0.07), fieldW, Math.max(2, rowH * 0.07));
      }
    } else if (row.kind === 'river') {
      const g = ctx.createLinearGradient(0, yBack, 0, yBack + rowH);
      g.addColorStop(0, '#1f5f9c');
      g.addColorStop(1, '#2a78bd');
      ctx.fillStyle = g;
      ctx.fillRect(left, yBack, fieldW, rowH + 1);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = Math.max(1, rowH * 0.045);
      for (let k = 0; k < 7; k++) {
        const wx = ((k * 3.1 + row.phase * 0.6 + row.variant * 9) % (2 * HALF_COLS + 2)) - HALF_COLS - 1;
        ctx.beginPath();
        ctx.moveTo(sx(wx), yBack + rowH * (0.3 + 0.4 * hash(k, row.index)));
        ctx.lineTo(sx(wx + 0.7), yBack + rowH * (0.3 + 0.4 * hash(k, row.index)));
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = '#5b5348';
      ctx.fillRect(left, yBack, fieldW, rowH + 1);
      ctx.fillStyle = '#463f37';
      for (let x = -HALF_COLS - 0.5; x < HALF_COLS + 0.5; x += 0.5) {
        ctx.fillRect(sx(x), yBack + rowH * 0.2, tile * 0.22, rowH * 0.6);
      }
      ctx.fillStyle = '#9aa4b0';
      ctx.fillRect(left, yBack + rowH * 0.26, fieldW, Math.max(2, rowH * 0.09));
      ctx.fillRect(left, yBack + rowH * 0.62, fieldW, Math.max(2, rowH * 0.09));
      // Signal posts: they are the only warning a train is coming.
      const lit = row.train === 'warn' && Math.floor(this.t * 6) % 2 === 0;
      const on = row.train === 'passing' || lit;
      for (const side of [-1, 1]) {
        const px = sx(side * (HALF_COLS + 0.5));
        this.box(px, gy(row.index), tile * 0.3, rowH * 0.3, tile * 0.55, '#7c8794', '#5a636e');
        ctx.fillStyle = on ? '#ff5a4a' : '#5c2b28';
        ctx.beginPath();
        ctx.arc(px, gy(row.index) - tile * 0.6, tile * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Hedges mark the hard edges of the playfield.
    for (const side of [-1, 1]) {
      const cx = sx(side * (HALF_COLS + 1));
      this.box(cx, gy(row.index), tile * 1.02, rowH, tile * 0.62, '#2f6b3a', '#22502c');
    }

    const ctx2 = this.ctx;
    ctx2.save();
    ctx2.beginPath();
    ctx2.rect(left, yBack - tile * 2.2, fieldW, rowH + tile * 2.4);
    ctx2.clip();
    this.drawContents(row, sx, gy, tile, rowH);
    ctx2.restore();
  }

  private drawContents(row: Row, sx: (x: number) => number, gy: (r: number) => number, tile: number, rowH: number): void {
    const ctx = this.ctx;
    const ground = gy(row.index);
    if (row.kind === 'grass') {
      for (const b of row.blockers) {
        const cx = sx(b.col);
        if (b.kind === 'tree') {
          this.box(cx, ground, tile * 0.24, rowH * 0.3, tile * 0.4, '#7a5233', '#5d3e26');
          this.box(cx, ground - tile * 0.34, tile * 0.86 * b.size, rowH * 0.62, tile * 0.78 * b.size, '#3f8b46', '#2f6b36');
          this.box(cx, ground - tile * 0.95, tile * 0.6 * b.size, rowH * 0.44, tile * 0.5 * b.size, '#4c9c52', '#3a7d40');
        } else if (b.kind === 'rock') {
          this.box(cx, ground, tile * 0.78 * b.size, rowH * 0.6, tile * 0.46 * b.size, '#9aa0a8', '#6f757d');
        } else {
          this.box(cx, ground, tile * 0.72 * b.size, rowH * 0.5, tile * 0.34 * b.size, '#57a355', '#3f7d40');
        }
      }
      if (row.coinCol !== null && !row.coinTaken) {
        const cx = sx(row.coinCol);
        const bob = Math.sin(this.t * 4 + row.coinCol) * tile * 0.06;
        const cy = ground - rowH * 0.4 - tile * 0.3 + bob;
        const rx = Math.abs(Math.cos(this.t * 3)) * tile * 0.16 + tile * 0.04;
        ctx.fillStyle = '#ffd75e';
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, tile * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        ctx.ellipse(cx - rx * 0.25, cy - tile * 0.05, rx * 0.35, tile * 0.09, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    if (row.kind === 'rail') {
      if (row.train === 'passing') this.drawTrain(row, sx, ground, tile, rowH);
      return;
    }
    for (const m of row.movers) {
      const x = moverX(row, m);
      // Skip anything comfortably offscreen: the stream is a full period wide.
      if (Math.abs(x) > HALF_COLS + LANE_PERIOD / 2) continue;
      if (row.kind === 'road') this.drawVehicle(m, sx(x), ground, tile, rowH, row.dir);
      else this.drawPlatform(m, sx(x), ground, tile, rowH);
    }
  }

  /* -------------------------------------------------------------- entities */

  private drawVehicle(m: Mover, cx: number, ground: number, tile: number, rowH: number, dir: number): void {
    const ctx = this.ctx;
    const w = m.w * tile;
    const hues = ['#e05a4c', '#e0a84c', '#4cc0e0', '#b46ce0', '#7ce06c'];
    const body = hues[Math.floor(m.tint * hues.length) % hues.length]!;
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(cx - w / 2, ground - rowH * 0.1, w, rowH * 0.12);
    if (m.kind === 'truck') {
      this.box(cx + dir * w * 0.34, ground - rowH * 0.16, w * 0.3, rowH * 0.42, tile * 0.62, body, this.shade(body, 0.72));
      this.box(cx - dir * w * 0.2, ground - rowH * 0.16, w * 0.68, rowH * 0.44, tile * 0.8, '#dfe4ea', '#aeb6bf');
    } else {
      this.box(cx, ground - rowH * 0.16, w, rowH * 0.44, tile * 0.36, body, this.shade(body, 0.72));
      this.box(cx - dir * w * 0.06, ground - rowH * 0.16 - tile * 0.3, w * 0.62, rowH * 0.36, tile * 0.3, this.shade(body, 1.12), '#25313d');
    }
    // Headlights on the leading end read the direction of travel at a glance.
    ctx.fillStyle = '#fff3b0';
    const lead = cx + dir * (w / 2 - tile * 0.08);
    ctx.beginPath();
    ctx.arc(lead, ground - rowH * 0.16 - tile * 0.14, tile * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPlatform(m: Mover, cx: number, ground: number, tile: number, rowH: number): void {
    const ctx = this.ctx;
    const w = m.w * tile;
    if (m.kind === 'pad') {
      ctx.fillStyle = '#2f7d3f';
      ctx.beginPath();
      ctx.ellipse(cx, ground - rowH * 0.42, w * 0.5, rowH * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#48a256';
      ctx.beginPath();
      ctx.ellipse(cx, ground - rowH * 0.46, w * 0.44, rowH * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f2e6a0';
      ctx.beginPath();
      ctx.arc(cx + w * 0.22, ground - rowH * 0.5, tile * 0.09, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(cx - w / 2, ground - rowH * 0.16, w, rowH * 0.1);
    this.box(cx, ground - rowH * 0.14, w, rowH * 0.5, tile * 0.22, '#8a6242', '#664529');
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = Math.max(1, tile * 0.03);
    for (let k = 1; k < 3; k++) {
      const lx = cx - w / 2 + (w * k) / 3;
      ctx.beginPath();
      ctx.moveTo(lx, ground - rowH * 0.14 - tile * 0.22);
      ctx.lineTo(lx, ground - rowH * 0.14);
      ctx.stroke();
    }
  }

  private drawTrain(row: Row, sx: (x: number) => number, ground: number, tile: number, rowH: number): void {
    const ctx = this.ctx;
    const cx = sx(row.trainX);
    const w = TRAIN_W * tile;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(cx - w / 2, ground - rowH * 0.1, w, rowH * 0.14);
    this.box(cx, ground - rowH * 0.1, w, rowH * 0.5, tile * 0.95, '#5f6d80', '#3d4756');
    ctx.fillStyle = '#ffe9a8';
    for (let k = 0; k < TRAIN_W; k += 1.5) {
      const wx = cx - w / 2 + k * tile + tile * 0.4;
      ctx.fillRect(wx, ground - rowH * 0.1 - tile * 0.78, tile * 0.5, tile * 0.3);
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx + (row.dir * w) / 2 - row.dir * tile * 0.2, ground - rowH * 0.1 - tile * 0.5, tile * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  /** The hopper: an original chunky character, no licensed likeness anywhere. */
  private drawPlayer(state: GameState, sx: (x: number) => number, gy: (r: number) => number, tile: number, rowH: number): void {
    const ctx = this.ctx;
    const p = state.player;
    const hop = p.hop;
    let x = p.x;
    let row = p.row;
    let lift = 0;
    let squash = 1;
    if (hop) {
      const e = hop.t;
      if (hop.bump) {
        // Refused move: lean into the obstacle and bounce back.
        const push = Math.sin(e * Math.PI) * 0.22;
        x += p.face === 'left' ? -push : p.face === 'right' ? push : 0;
        row += p.face === 'up' ? push : p.face === 'down' ? -push : 0;
        squash = 1 - Math.sin(e * Math.PI) * 0.12;
      } else {
        x = hop.fromX + (hop.toX - hop.fromX) * e;
        row = hop.fromRow + (hop.toRow - hop.fromRow) * e;
        lift = Math.sin(e * Math.PI) * HOP_HEIGHT * tile;
        squash = 1 + Math.sin(e * Math.PI) * 0.16;
      }
    }
    const cx = sx(x);
    const ground = gy(row) - rowH * 0.18;
    const bodyW = tile * 0.62;
    const bodyH = tile * 0.5 * squash;

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(cx, ground, bodyW * 0.5 * (1 - lift / (tile * 2)), rowH * 0.16 * (1 - lift / (tile * 2.4)), 0, 0, Math.PI * 2);
    ctx.fill();

    const y = ground - lift;
    this.box(cx, y, bodyW, rowH * 0.3, bodyH, '#f5f0e2', '#d8d0bd');
    // Head
    const headY = y - bodyH - rowH * 0.06;
    this.box(cx, headY, bodyW * 0.86, rowH * 0.26, tile * 0.36, '#fdfaf1', '#e2dac6');
    const faceDir = p.face === 'left' ? -1 : p.face === 'right' ? 1 : 0;
    ctx.fillStyle = '#1d232c';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(cx + side * bodyW * 0.2 + faceDir * bodyW * 0.1, headY - tile * 0.22, tile * 0.055, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f2a03d';
    ctx.beginPath();
    ctx.moveTo(cx + faceDir * bodyW * 0.16, headY - tile * 0.14);
    ctx.lineTo(cx + faceDir * bodyW * 0.16 + (faceDir || 0) * tile * 0.12, headY - tile * 0.1);
    ctx.lineTo(cx + faceDir * bodyW * 0.16, headY - tile * 0.06);
    ctx.closePath();
    ctx.fill();
    if (faceDir === 0) {
      ctx.fillRect(cx - tile * 0.055, headY - tile * 0.14, tile * 0.11, tile * 0.08);
    }
  }

  /** The hawk marks the frontier: the closer it gets, the louder it is. */
  private drawHawk(
    state: GameState, sx: (x: number) => number, gy: (r: number) => number,
    tile: number, rowH: number, vp: Viewport,
  ): void {
    const ctx = this.ctx;
    const y = gy(state.frontier);
    if (y < vp.h) {
      const void_ = ctx.createLinearGradient(0, y, 0, Math.min(vp.h, y + rowH * 4));
      void_.addColorStop(0, 'rgba(14,9,22,0.34)');
      void_.addColorStop(1, 'rgba(9,6,16,0.82)');
      ctx.fillStyle = void_;
      ctx.fillRect(0, y, vp.w, vp.h - y);
    }
    ctx.strokeStyle = 'rgba(255,90,74,0.75)';
    ctx.lineWidth = Math.max(2, rowH * 0.09);
    ctx.setLineDash([tile * 0.5, tile * 0.35]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(vp.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (slack(state) > 3.4) return;
    const hx = sx(state.player.x) + Math.sin(this.t * 2.2) * tile * 1.4;
    const hy = y + rowH * 0.5 + Math.cos(this.t * 3) * rowH * 0.2;
    const flap = Math.sin(this.t * 12) * 0.4;
    ctx.fillStyle = '#2b1a1a';
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - tile * 1.1, hy - tile * (0.28 + flap) * 0.6);
    ctx.lineTo(hx - tile * 0.28, hy + tile * 0.1);
    ctx.lineTo(hx + tile * 0.28, hy + tile * 0.1);
    ctx.lineTo(hx + tile * 1.1, hy - tile * (0.28 + flap) * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e0b04c';
    ctx.beginPath();
    ctx.arc(hx, hy - tile * 0.04, tile * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawVignette(state: GameState, vp: Viewport): void {
    const danger = Math.max(0, 1 - slack(state) / 2.6);
    if (danger <= 0 || state.phase !== 'playing') return;
    const ctx = this.ctx;
    // Steady instead of throbbing under reduced motion: the danger still reads,
    // it just stops pulsing.
    const pulse = this.reducedMotion ? 0.45 : 0.35 + 0.25 * Math.sin(this.t * 9);
    const g = ctx.createRadialGradient(vp.w / 2, vp.h / 2, Math.min(vp.w, vp.h) * 0.25, vp.w / 2, vp.h / 2, Math.max(vp.w, vp.h) * 0.7);
    g.addColorStop(0, 'rgba(255,60,50,0)');
    g.addColorStop(1, `rgba(255,60,50,${(danger * pulse).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vp.w, vp.h);
  }

  /* --------------------------------------------------------------- helpers */

  /** One chunky solid: a front face plus a lighter top face. */
  private box(cx: number, groundY: number, w: number, depth: number, height: number, top: string, front: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = front;
    ctx.fillRect(cx - w / 2, groundY - height, w, height);
    ctx.fillStyle = top;
    ctx.fillRect(cx - w / 2, groundY - height - depth, w, depth + 1);
  }

  private shade(hex: string, f: number): string {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
}

/** Exposed for the smoke test: HOP_TIME is the canonical hop duration. */
export const HOP_DURATION = HOP_TIME;
