import './style.css';
import { Game } from './game/game';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const game = new Game({
  canvas: el<HTMLCanvasElement>('scene'),
  overlay: el('overlay'),
  overlayTitle: el('overlay-title'),
  overlayBody: el('overlay-body'),
  overlayAction: el<HTMLButtonElement>('overlay-action'),
  score: el('score'),
  best: el('best'),
  rows: el('rows'),
  rowsLabel: el('rows-label'),
  coins: el('coins'),
  danger: el('danger'),
  callout: el('callout'),
  pauseBtn: el<HTMLButtonElement>('pause-btn'),
  muteBtn: el<HTMLButtonElement>('mute-btn'),
});

// Exposed so the Playwright smoke test can inspect real simulation state
// instead of guessing from pixels.
declare global {
  interface Window {
    tinyRoadHopper: Game;
  }
}
window.tinyRoadHopper = game;
