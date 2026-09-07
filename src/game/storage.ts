/** Best score persistence. Wrapped because localStorage throws in private
 *  browsing modes and a blocked read must not take the game down. */
const KEY = 'tiny-road-hopper:best';
const MUTE_KEY = 'tiny-road-hopper:muted';

export function loadBest(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  } catch {
    return 0;
  }
}

export function saveBest(score: number): void {
  try {
    localStorage.setItem(KEY, String(Math.floor(score)));
  } catch {
    /* storage unavailable - best score is session-only */
  }
}

export function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveMuted(m: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    /* ignore */
  }
}
