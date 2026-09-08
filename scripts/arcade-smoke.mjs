/**
 * Kiểm thử tích hợp platform Arcade — chạy trên bundle ĐANG ĐƯỢC PLATFORM PHỤC VỤ,
 * không phải server tĩnh tự dựng. Chứng minh đúng ba thứ mà `npm run smoke`
 * không chứng minh được, vì ở đó platform cố tình vắng mặt:
 *
 *   1. SDK bắt tay được với API thật (guest auth) -> ArcadeGame.ready
 *   2. điểm một lượt chơi thật đi vào leaderboard và đọc ngược ra được
 *   3. kỷ lục đi vào cloud save và quay về ở phiên sau (đổi máy vẫn còn)
 *
 * Dùng:  node scripts/arcade-smoke.mjs [baseUrl]
 * Mặc định http://127.0.0.1:8090/g/tiny-road-hopper/
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8090/g/tiny-road-hopper/').replace(/\/?$/, '/');
const BEST_KEY = 'tiny-road-hopper:best';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.tinyRoadHopper, null, { timeout: 10_000 });

// 1. Bắt tay với API thật. Đây là chỗ phân biệt "có gọi SDK" với "SDK chạy được".
const handshake = await page
  .waitForFunction(() => window.ArcadeGame?.ready === true, null, { timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
const who = await page.evaluate(() => ({
  ready: window.ArcadeGame?.ready ?? false,
  playerId: window.ArcadeGame?.playerId ?? null,
}));
check('SDK bắt tay được với platform (guest auth)', handshake && !!who.playerId,
  JSON.stringify(who));
if (!handshake) {
  console.log('\nDừng sớm: không bắt tay được thì các cổng sau vô nghĩa.');
  await browser.close();
  process.exit(1);
}

// 2. Ép một lượt chơi kết thúc với điểm biết trước, rồi đọc ngược từ bảng.
//    Điểm ở đây là maxRow + coins*COIN_BONUS (logic.ts:301). Đẩy maxRow lên
//    TARGET là kéo luôn frontier tới TARGET - BEHIND_LIMIT ngay tick sau
//    (logic.ts:293), hopper còn đứng ở hàng 0 nên diều hâu tóm ngay: lượt chơi
//    kết thúc thật qua đúng đường game-over của game, với điểm biết trước.
const TARGET = 700 + Math.floor(Number(process.env.ARCADE_SMOKE_SALT ?? '0'));
await page.locator('#overlay-action').click();
await page.waitForFunction(() => window.tinyRoadHopper.state.phase === 'playing',
  null, { timeout: 5000 });
await page.evaluate((target) => { window.tinyRoadHopper.state.maxRow = target; }, TARGET);
await page.waitForFunction(() => window.tinyRoadHopper.state.phase === 'over',
  null, { timeout: 8000 });
const run = await page.evaluate(() => ({
  score: Math.floor(window.tinyRoadHopper.state.score),
  cause: window.tinyRoadHopper.state.cause,
}));
check('lượt chơi kết thúc với điểm > 0', run.score === TARGET && !!run.cause,
  `score=${run.score}, ${run.cause}`);

const runScore = run.score;
const onBoard = await page
  .waitForFunction(async (score) => {
    const rows = await window.ArcadeGame.top('alltime', 25);
    return Array.isArray(rows) && rows.some((r) => r.score === score);
  }, runScore, { timeout: 15_000, polling: 700 })
  .then(() => true)
  .catch(() => false);
const board = await page.evaluate(() => window.ArcadeGame.top('alltime', 5));
check('điểm vào bảng alltime và đọc ngược ra được', onBoard,
  JSON.stringify(board?.slice?.(0, 3) ?? board));

const onDaily = await page
  .waitForFunction(async (score) => {
    const rows = await window.ArcadeGame.top('daily', 25);
    return Array.isArray(rows) && rows.some((r) => r.score === score);
  }, runScore, { timeout: 10_000, polling: 700 })
  .then(() => true)
  .catch(() => false);
check('điểm vào bảng daily', onDaily);

// 3. Cloud save: nạp lại trang, kỷ lục phải quay về từ platform chứ không chỉ localStorage.
//    Game giữ kỷ lục trong field riêng của Game, nên đọc qua hai mặt công khai
//    của nó: ô Best trên HUD và khoá localStorage.
const best = await page.evaluate(() => Number(document.getElementById('best').textContent));
check('kỷ lục cục bộ đã lên tới điểm lượt vừa chơi', best >= runScore, `best=${best}`);
await page.waitForTimeout(1200);          // để save.set kịp bay đi
// Chỉ xoá kỷ lục cục bộ, KHÔNG xoá cả localStorage: phiên guest của SDK
// (khoá "arcade:<gameId>") cũng nằm trong đó. Xoá sạch = thành người chơi mới,
// và khi đó save trống là đúng chứ không phải lỗi tích hợp.
// Đọc lại NGAY tại đây chứ không sau reload: sau reload bridge đã kịp ghi đè,
// lúc đó thấy giá trị cũng không chứng minh được là đã xoá.
const cleared = await page.evaluate((k) => {
  localStorage.removeItem(k);
  return localStorage.getItem(k);
}, BEST_KEY);
check('kỷ lục cục bộ đã bị xoá sạch trước khi nạp lại', cleared === null, `local=${cleared}`);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.ArcadeGame?.ready === true, null, { timeout: 15_000 });
const restored = await page
  .waitForFunction((b) => Number(document.getElementById('best').textContent) >= b, best,
    { timeout: 10_000, polling: 500 })
  .then(() => true)
  .catch(() => false);
const after = await page.evaluate((k) => ({
  hud: document.getElementById('best').textContent,
  local: localStorage.getItem(k),
}), BEST_KEY);
check('kỷ lục quay về từ cloud save sau khi xoá bản cục bộ', restored,
  `best=${best} -> ${JSON.stringify(after)}`);
// Nhận kỷ lục xa mà không ghi lại thì lần mở sau không có mạng là mất trắng.
check('kỷ lục xa được ghi lại xuống localStorage', Number(after.local) >= best,
  `local=${after.local}`);

check('không có lỗi console/page', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} cổng pass  (${BASE})`);
process.exit(failed.length === 0 ? 0 : 1);
