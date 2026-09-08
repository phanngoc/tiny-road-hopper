/**
 * Cầu nối tới platform Arcade (com.ngocp.arcade).
 *
 * Nguyên tắc giống blockdrop: platform là BỔ SUNG, không phải phụ thuộc.
 * `public/arcade-bridge.js` chỉ gắn `window.ArcadeGame` khi SDK nạp được; nếu
 * platform chết, mở file tĩnh, hay chạy trong vitest (không có window) thì mọi
 * hàm dưới đây thành no-op và game vẫn chơi y như cũ bằng localStorage.
 */

export interface ArcadeBridge {
  ready: boolean;
  playerId: string | null;
  onScore(board: string, score: number, name?: string | null): void;
  syncSave(data: unknown): void;
  top(board: string, n?: number): Promise<unknown[]>;
  /** Doc save platform kéo về trước khi game kịp đăng ký callback. */
  remote?: unknown;
  track?(name: string, props?: Record<string, unknown>): void;
}

type ArcadeWindow = typeof globalThis & {
  ArcadeGame?: ArcadeBridge;
  __arcadeApplyRemote?: (data: unknown) => void;
};

function bridge(): ArcadeBridge | null {
  const w = globalThis as ArcadeWindow;
  const b = w.ArcadeGame;
  return b && typeof b.onScore === 'function' ? b : null;
}

/** Điểm của MỘT lượt chơi vừa kết thúc -> cả hai bảng đã khai trong arcade.toml. */
export function submitRun(score: number): void {
  const b = bridge();
  if (!b || !Number.isFinite(score) || score <= 0) return;
  const n = Math.trunc(score);
  b.onScore('daily', n);
  b.onScore('alltime', n);
}

/** Kỷ lục cá nhân -> cloud save, để đổi máy vẫn còn. */
export function syncBest(best: number): void {
  const b = bridge();
  if (!b || !Number.isFinite(best) || best <= 0) return;
  b.syncSave({ best: Math.trunc(best) });
}

export function track(name: string, props?: Record<string, unknown>): void {
  const b = bridge();
  b?.track?.(name, props);
}

/**
 * Nhận save từ máy khác. Bridge gọi `window.__arcadeApplyRemote` một lần khi
 * kéo được doc về. Game tự quyết dùng hay không — ở đây chỉ nhận số lớn hơn,
 * nên kỷ lục không bao giờ bị tụt vì một máy cũ.
 */
export function onRemoteBest(apply: (best: number) => void): void {
  const w = globalThis as ArcadeWindow;
  if (typeof w !== 'object' || w === null) return;
  const take = (data: unknown): void => {
    const best = (data as { best?: unknown } | null)?.best;
    if (typeof best === 'number' && Number.isFinite(best) && best > 0) {
      apply(Math.trunc(best));
    }
  };
  w.__arcadeApplyRemote = take;
  // Hai chiều của cùng một cuộc đua: nếu save.get() đã về TRƯỚC khi game kịp
  // đăng ký, bridge đã giữ doc lại ở .remote — đọc luôn, đừng chờ callback nữa.
  const pending = bridge()?.remote;
  if (pending) take(pending);
}
