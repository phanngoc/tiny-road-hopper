/** Wires the pure simulation to the canvas, the DOM HUD and the input layer. */
import { onRemoteBest, submitRun, syncBest, track } from './arcade';
import { Renderer } from './render';
import type { Viewport } from './render';
import { Sfx } from './audio';
import { attachInput } from './input';
import { applyAction, createState, rowAt, slack, startRun, step } from './logic';
import { loadBest, loadMuted, saveBest, saveMuted } from './storage';
import { BEHIND_LIMIT } from './config';
import type { Action, GameEvent, GameState } from './types';

const FIXED_DT = 1 / 120;
const MAX_CATCHUP = 0.25;

interface Dom {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  overlayTitle: HTMLElement;
  overlayBody: HTMLElement;
  overlayAction: HTMLButtonElement;
  score: HTMLElement;
  best: HTMLElement;
  rows: HTMLElement;
  coins: HTMLElement;
  danger: HTMLElement;
  callout: HTMLElement;
  pauseBtn: HTMLButtonElement;
  muteBtn: HTMLButtonElement;
}

export class Game {
  state: GameState;
  private renderer: Renderer;
  private sfx = new Sfx();
  private acc = 0;
  private last = 0;
  private vp: Viewport = { w: 0, h: 0, dpr: 1 };
  private bestScore = loadBest();
  /** Frame counter, read by the browser smoke test to prove the loop advances. */
  frames = 0;
  private seed = 1;
  private detach: () => void;
  private hornedRow = -1;

  constructor(private dom: Dom) {
    const ctx = dom.canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.renderer = new Renderer(ctx);
    this.state = createState(this.seed);
    this.sfx.setMuted(loadMuted());
    this.detach = attachInput(dom.canvas, {
      action: (a) => this.input(a),
      togglePause: () => this.togglePause(),
      toggleMute: () => this.toggleMute(),
      confirm: () => this.confirm(),
    });
    dom.overlayAction.addEventListener('click', () => this.confirm());
    dom.pauseBtn.addEventListener('click', () => this.togglePause());
    dom.muteBtn.addEventListener('click', () => this.toggleMute());
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state.phase === 'playing') this.togglePause();
    });
    // Save từ máy khác về: chỉ nhận kỷ lục CAO HƠN, không bao giờ để tụt.
    // Ghi luôn xuống localStorage để lần sau không phải chờ mạng nữa.
    onRemoteBest((best) => {
      if (best <= this.bestScore) return;
      this.bestScore = best;
      saveBest(best);
      this.updateHud();
    });

    this.resize();
    this.syncMuteButton();
    this.showMenu();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  dispose(): void {
    this.detach();
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.vp = { w, h, dpr };
    this.dom.canvas.width = Math.round(w * dpr);
    this.dom.canvas.height = Math.round(h * dpr);
    this.dom.canvas.style.width = `${w}px`;
    this.dom.canvas.style.height = `${h}px`;
  }

  private input(a: Action): void {
    if (this.state.phase !== 'playing') return;
    this.consume(applyAction(this.state, a));
  }

  /** The one button / Enter key: start, resume or restart depending on phase. */
  confirm(): void {
    if (this.state.phase === 'menu' || this.state.phase === 'over') this.restart();
    else if (this.state.phase === 'paused') this.togglePause();
  }

  restart(): void {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0 || 1;
    this.state = createState(this.seed);
    this.renderer.reset();
    startRun(this.state);
    this.acc = 0;
    this.hornedRow = -1;
    this.last = performance.now();
    this.dom.overlay.classList.add('hidden');
    this.dom.callout.textContent = '';
    this.updateHud();
  }

  togglePause(): void {
    if (this.state.phase === 'playing') {
      this.state.phase = 'paused';
      this.showOverlay('Paused', '<p>The hawk waits politely. Take your time.</p>', 'Resume');
    } else if (this.state.phase === 'paused') {
      this.state.phase = 'playing';
      this.dom.overlay.classList.add('hidden');
      this.last = performance.now();
    }
  }

  toggleMute(): void {
    this.sfx.setMuted(!this.sfx.muted);
    saveMuted(this.sfx.muted);
    this.syncMuteButton();
  }

  private syncMuteButton(): void {
    this.dom.muteBtn.textContent = this.sfx.muted ? 'Sound off' : 'Sound on';
    this.dom.muteBtn.setAttribute('aria-pressed', String(this.sfx.muted));
  }

  private showMenu(): void {
    this.showOverlay(
      'Tiny Road Hopper',
      `<p>Hop tile by tile across endless roads, rivers and railways.
       The <strong>frontier</strong> creeps forward the whole time &mdash; fall more than
       ${BEHIND_LIMIT} rows behind it and the hawk takes you.</p>
       <ul>
         <li><b>&uarr; &darr; &larr; &rarr;</b> or <b>WASD</b> &mdash; hop one tile</li>
         <li><b>Swipe</b> to hop that way &middot; <b>tap</b> to hop forward</li>
         <li><b>P</b> pause &middot; <b>M</b> mute &middot; <b>Enter</b> start / restart</li>
       </ul>
       <p>Traffic flattens you. Water drowns you &mdash; ride the
       <span class="pw lg">logs</span> and lily pads, but do not let the current carry you
       off the map. Red signal lamps mean a <span class="pw tr">train</span> is seconds away.
       <span class="pw co">Coins</span> are worth 3 points each.</p>`,
      'Start hopping',
    );
  }

  private showOverlay(title: string, body: string, action: string): void {
    this.dom.overlayTitle.textContent = title;
    this.dom.overlayBody.innerHTML = body;
    this.dom.overlayAction.textContent = action;
    this.dom.overlay.classList.remove('hidden');
  }

  private consume(events: GameEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'hop':
          this.sfx.hop();
          break;
        case 'bump':
          this.sfx.bump();
          break;
        case 'coin':
          this.sfx.coin();
          break;
        case 'board':
          this.sfx.board();
          break;
        case 'milestone':
          this.sfx.milestone();
          this.flash(`${e.row} rows!`);
          break;
        case 'train-warn':
          this.sfx.horn();
          this.flash('Train coming!');
          break;
        case 'over':
          if (/river|swept/.test(e.cause)) this.sfx.splash();
          else this.sfx.crash();
          this.renderer.kick(1);
          this.gameOver(e.cause);
          break;
      }
    }
  }

  private flash(text: string): void {
    this.dom.callout.textContent = text;
    this.dom.callout.classList.remove('pop');
    // Force a reflow so the animation restarts on repeated callouts.
    void this.dom.callout.offsetWidth;
    this.dom.callout.classList.add('pop');
  }

  private gameOver(cause: string): void {
    const score = Math.floor(this.state.score);
    const isBest = score > this.bestScore;
    if (isBest) {
      this.bestScore = score;
      saveBest(score);
    }
    // Platform: điểm LƯỢT vừa xong lên bảng, kỷ lục lên cloud save. Cả hai nuốt
    // lỗi trong arcade.ts nên platform chết cũng không chặn màn game over.
    submitRun(score);
    syncBest(this.bestScore);
    track('run_over', { score, rows: this.state.maxRow, coins: this.state.coins, cause });
    this.showOverlay(
      'Squashed',
      `<p class="cause">You ${cause}.</p>
       <p class="tally"><b>${score}</b> points &middot; ${this.state.maxRow} rows &middot;
       ${this.state.coins} coins &middot; ${this.state.hops} hops</p>
       <p>${isBest ? 'New personal best!' : `Best: ${this.bestScore}`}</p>`,
      'Hop again',
    );
    this.updateHud();
  }

  private updateHud(): void {
    const s = this.state;
    this.dom.score.textContent = String(Math.floor(s.score));
    this.dom.best.textContent = String(Math.max(this.bestScore, Math.floor(s.score)));
    this.dom.rows.textContent = String(s.maxRow);
    this.dom.coins.textContent = String(s.coins);
    const left = slack(s);
    const pct = Math.max(0, Math.min(1, left / BEHIND_LIMIT));
    this.dom.danger.style.setProperty('--fill', `${(pct * 100).toFixed(0)}%`);
    this.dom.danger.classList.toggle('critical', s.phase === 'playing' && pct < 0.34);
    this.dom.danger.setAttribute('aria-label', `Distance ahead of the hawk: ${left.toFixed(1)} rows`);
  }

  private frame(now: number): void {
    const dt = Math.min(MAX_CATCHUP, (now - this.last) / 1000);
    this.last = now;
    if (this.state.phase === 'playing') {
      this.acc += dt;
      // Fixed timestep: physics is frame-rate independent and matches the tests.
      while (this.acc >= FIXED_DT) {
        this.acc -= FIXED_DT;
        this.consume(step(this.state, FIXED_DT));
        if (this.state.phase !== 'playing') break;
      }
      this.announceRow();
    }
    this.renderer.follow(this.state, dt, this.vp);
    this.renderer.draw(this.state, this.vp);
    this.updateHud();
    this.frames++;
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Warn once when the hopper is standing on a rail with a train inbound. */
  private announceRow(): void {
    const row = rowAt(this.state, this.state.player.row);
    if (!row || row.kind !== 'rail' || row.train === 'idle') {
      if (this.hornedRow !== -1 && (!row || row.index !== this.hornedRow)) this.hornedRow = -1;
      return;
    }
    if (this.hornedRow === row.index) return;
    this.hornedRow = row.index;
    this.flash('Off the tracks!');
  }
}
