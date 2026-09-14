/**
 * Captures the acceptance viewports at menu / mid-run / game-over from a built
 * bundle, so a change can be compared against the same world and the same
 * depth. Also audits every visible touch target in each phase.
 *
 * Usage: node scripts/shots.mjs <dist-dir> <out-dir> <label>
 *
 * The world is pinned without adding a test-only hook: a fresh load always
 * starts at seed 1 and Game.restart() advances it with a fixed LCG, so calling
 * restart() exactly once after load yields seed 1015568748 on every build --
 * the baseline bundle runs the identical procedure.
 *
 * LIMITATION, stated plainly: the hopper is driven by the page's own real-time
 * frame loop, so traffic phase at the capture instant is NOT bit-identical
 * between two runs. What is pinned is the generated world (seed) and the depth
 * at which the shot is taken (PLAY_ROW), which is what makes the before/after
 * pair comparable. This is emulated Chromium, not a physical phone.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const [distArg, outArg, label = 'shot'] = process.argv.slice(2);
const ROOT = resolve(distArg ?? 'dist') + sep;
const OUT = resolve(outArg ?? 'docs/shots');
const PORT = 4336;
/** Depth the mid-run shot is taken at: far enough to have crossed road, river
 *  and usually rail, shallow enough that the pilot reliably survives. */
const PLAY_ROW = 14;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT)) return res.writeHead(403).end('forbidden');
    const body = await readFile(file);
    // Derive the type from the resolved FILE, not the URL: '/' has no extension.
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', r); });
await mkdir(OUT, { recursive: true });

/** Named in the mobile acceptance criteria, plus short landscape and desktop. */
const VIEWPORTS = [
  { id: '360x640', width: 360, height: 640, dpr: 2, touch: true },
  { id: '390x844', width: 390, height: 844, dpr: 2, touch: true },
  { id: '430x932', width: 430, height: 932, dpr: 2, touch: true },
  { id: '844x390', width: 844, height: 390, dpr: 2, touch: true },
  { id: '1280x800', width: 1280, height: 800, dpr: 1, touch: false },
];

/** Audit every visible control a thumb could aim at in the current phase.
 *  Serialised into the page, so it must stay self-contained. */
const auditControls = (scope) => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const small = [];
  const unreachable = [];
  for (const b of document.querySelectorAll(scope)) {
    const r = b.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(b);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const id = b.id || b.className || b.tagName;
    if (r.width < 44 || r.height < 44) small.push(id + '=' + Math.round(r.width) + 'x' + Math.round(r.height));
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) { unreachable.push(id + '=offscreen'); continue; }
    // A size check alone cannot see a control covered by another layer, so
    // probe the exact point a thumb would land on.
    const hit = document.elementFromPoint(cx, cy);
    if (hit !== b && !b.contains(hit)) unreachable.push(id + '=covered-by-' + (hit && (hit.id || hit.tagName)));
  }
  return { small, unreachable };
};

/** Plays to PLAY_ROW through the public input path, refusing to step into a
 *  hazard. Mirrors the sim's own geometry (wrap/moverX) rather than calling it,
 *  because the bundle does not export logic to the page. */
const pilot = (targetRow) =>
  new Promise((done) => {
    const g = window.tinyRoadHopper;
    const HALF_COLS = 6, PERIOD = 26, PLAYER_W = 0.72;
    const wrap = (v) => ((((v + PERIOD / 2) % PERIOD) + PERIOD) % PERIOD) - PERIOD / 2;
    const at = (s, i) => s.rows.find((r) => r.index === i);
    const blocked = (row, col) => !row || col < -HALF_COLS || col > HALF_COLS || row.blockers.some((b) => b.col === col);
    let guard = 0;
    const tick = () => {
      const s = g.state;
      if (s.phase !== 'playing') return done({ alive: false, row: s.player.row, cause: s.cause });
      if (s.player.row >= targetRow) return done({ alive: true, row: s.player.row, cause: null });
      if (++guard > 3000) return done({ alive: true, row: s.player.row, cause: 'pilot-timeout' });
      const p = s.player;
      if (!p.hop) {
        const col = Math.round(p.x);
        const next = at(s, p.row + 1);
        // Sidestep a blocker rather than bumping into it.
        if (blocked(next, col)) {
          const free = [col + 1, col - 1].find((c) => !blocked(next, c) && !blocked(at(s, p.row), c));
          if (free !== undefined) g.input(free > col ? 'right' : 'left');
        } else if (safe(s, next, col)) {
          g.input('up');
        }
      }
      requestAnimationFrame(tick);
    };
    /** Would standing at col on `row` be survivable now and shortly after? */
    function safe(s, row, col) {
      if (!row) return false;
      if (row.kind === 'grass') return true;
      if (row.kind === 'rail') return row.train === 'idle' && row.trainTimer > 1.2;
      if (row.kind === 'road') {
        // Look ahead over the hop plus a dwell, in steps, so a fast car cannot
        // cross the gap between two samples.
        for (let t = 0; t <= 0.75; t += 0.05) {
          const ph = row.phase + row.dir * row.speed * t;
          for (const m of row.movers) if (Math.abs(wrap(m.p + ph) - col) < (m.w + PLAYER_W) / 2 + 0.35) return false;
        }
        return true;
      }
      // River: only board a platform that is comfortably under the target cell.
      for (const m of row.movers) if (Math.abs(wrap(m.p + row.phase) - col) <= m.w / 2 - 0.25) return true;
      return false;
    }
    requestAnimationFrame(tick);
  });

const browser = await chromium.launch();
const report = [];
for (const v of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.dpr, hasTouch: v.touch, isMobile: v.touch,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.tinyRoadHopper?.frames > 2);

  await page.screenshot({ path: join(OUT, `${label}-${v.id}-1-menu.png`) });
  const menuControls = await page.evaluate(auditControls, 'button');
  const menuWords = await page.evaluate(
    () => (document.getElementById('overlay-body')?.innerText || '').trim().split(/\s+/).filter(Boolean).length,
  );

  await page.evaluate(() => window.tinyRoadHopper.restart()); // fixed LCG => same world every build
  const played = await page.evaluate(pilot, PLAY_ROW);
  if (!played.alive) console.log(`  ! pilot died at row ${played.row} (${played.cause}) on ${v.id}`);
  await page.waitForTimeout(80);
  const playControls = await page.evaluate(auditControls, 'button');
  const metrics = await page.evaluate(() => {
    const g = window.tinyRoadHopper;
    const c = document.getElementById('scene');
    const rect = c.getBoundingClientRect();
    const s = g.state;
    return {
      phase: s.phase, row: s.player.row, maxRow: s.maxRow, score: Math.floor(s.score), coins: s.coins,
      slackRows: +(s.maxRow - s.frontier).toFixed(2),
      renderScale: +(c.width / rect.width).toFixed(2),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      verticalScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  });
  await page.screenshot({ path: join(OUT, `${label}-${v.id}-2-play.png`) });

  // Game over, reached by standing still until the frontier catches up: the
  // page's own loop ends the run and the card has to name a cause.
  await page.waitForFunction(() => window.tinyRoadHopper.state.phase === 'over', null, { timeout: 90000 });
  await page.waitForTimeout(200);
  const over = await page.evaluate(auditControls, '#overlay button');
  const overInfo = await page.evaluate(() => ({
    title: document.getElementById('overlay-title')?.textContent,
    body: (document.getElementById('overlay-body')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    cause: window.tinyRoadHopper.state.cause,
  }));
  await page.screenshot({ path: join(OUT, `${label}-${v.id}-3-over.png`) });

  report.push({ viewport: v.id, played, menuWords, ...metrics, menuControls, playControls, over, overInfo, errors });
  console.log(
    `${v.id}  dprCap=${metrics.renderScale}  overflow=${metrics.horizontalOverflow}px  ` +
      `small=${[...menuControls.small, ...playControls.small, ...over.small].join(',') || 'none'}  ` +
      `unreachable=${[...menuControls.unreachable, ...playControls.unreachable, ...over.unreachable].join(',') || 'none'}  ` +
      `row=${metrics.row} menuWords=${menuWords}  cause="${overInfo.cause}"  errors=${errors.length}`,
  );
  await context.close();
}
await writeFile(join(OUT, `${label}-report.json`), JSON.stringify(report, null, 2));
await browser.close();
server.close();
console.log(`\nwrote ${OUT}/${label}-*.png`);
