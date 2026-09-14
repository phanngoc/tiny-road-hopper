/** Keyboard + pointer/touch input. Swipes hop in the swiped direction, a tap
 *  hops forward - the move you want nine times out of ten. */
import type { Action } from './types';

export interface InputHandlers {
  action: (a: Action) => void;
  togglePause: () => void;
  toggleMute: () => void;
  confirm: () => void;
}

const SWIPE_MIN = 24;

export function attachInput(target: HTMLElement, h: InputHandlers): () => void {
  const keyMap: Record<string, Action> = {
    ArrowUp: 'up', KeyW: 'up', Space: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.repeat && e.code === 'Space') return;
    if (e.code === 'KeyP' || e.code === 'Escape') {
      e.preventDefault();
      h.togglePause();
      return;
    }
    if (e.code === 'KeyM') {
      h.toggleMute();
      return;
    }
    if (e.code === 'Enter') {
      e.preventDefault();
      h.confirm();
      return;
    }
    const a = keyMap[e.code];
    if (a) {
      e.preventDefault();
      h.action(a);
    }
  };
  window.addEventListener('keydown', onKey);

  let start: { x: number; y: number; t: number } | null = null;
  let fired = false;

  const down = (x: number, y: number) => {
    start = { x, y, t: performance.now() };
    fired = false;
  };
  const move = (x: number, y: number) => {
    if (!start || fired) return;
    const dx = x - start.x;
    const dy = y - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN) return;
    fired = true;
    // Screen y grows downwards; forward is up the screen.
    if (Math.abs(dx) > Math.abs(dy)) h.action(dx > 0 ? 'right' : 'left');
    else h.action(dy > 0 ? 'down' : 'up');
  };
  const up = () => {
    if (start && !fired && performance.now() - start.t < 350) h.action('up');
    start = null;
  };
  /** Drop the gesture without firing it. A touch that the browser takes away
   *  (scroll takeover, call banner, app switch) never delivers touchend, so
   *  without this the half-finished swipe stays armed and the next unrelated
   *  touchmove completes it as a hop the player never asked for. */
  const cancel = () => {
    start = null;
    fired = false;
  };

  const onTouchStart = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    if (t) down(t.clientX, t.clientY);
  };
  const onTouchMove = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    if (t) move(t.clientX, t.clientY);
    e.preventDefault();
  };
  const onMouseDown = (e: MouseEvent) => down(e.clientX, e.clientY);
  const onMouseMove = (e: MouseEvent) => move(e.clientX, e.clientY);
  const onHidden = () => {
    if (document.hidden) cancel();
  };

  target.addEventListener('touchstart', onTouchStart, { passive: true });
  target.addEventListener('touchmove', onTouchMove, { passive: false });
  target.addEventListener('touchend', up);
  target.addEventListener('touchcancel', cancel);
  target.addEventListener('pointercancel', cancel);
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('mousemove', onMouseMove);
  target.addEventListener('mouseup', up);
  // The pointer leaving the surface mid-gesture is a cancel, not a tap.
  target.addEventListener('mouseleave', cancel);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', onHidden);

  return () => {
    window.removeEventListener('keydown', onKey);
    target.removeEventListener('touchstart', onTouchStart);
    target.removeEventListener('touchmove', onTouchMove);
    target.removeEventListener('touchend', up);
    target.removeEventListener('touchcancel', cancel);
    target.removeEventListener('pointercancel', cancel);
    target.removeEventListener('mousedown', onMouseDown);
    target.removeEventListener('mousemove', onMouseMove);
    target.removeEventListener('mouseup', up);
    target.removeEventListener('mouseleave', cancel);
    window.removeEventListener('blur', cancel);
    document.removeEventListener('visibilitychange', onHidden);
  };
}
