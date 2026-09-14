/**
 * Frame-interval distribution over a seeded 60s run after 3s of warm-up,
 * plus a Chromium-only JS heap trend. No test-only stepping hook is used.
 * The shots.mjs pilot plays to row 14, then restarts with the next LCG seed.
 * Planned cycles and unexpected deaths/timeouts are recorded separately.
 *
 * Usage: node <script> <dist-dir> [390x844|1280x800]
 * Writes docs/shots/perf-<viewport-id>.json relative to the working directory.
 * Save each build's JSON before running again for a before/after comparison.
 *
 * This measures headless Chromium on the host machine with an emulated
 * viewport. It is NOT a physical iPhone/Android measurement or an FPS promise.
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { platform, arch } from 'node:os';

const [distArg, viewportId = '390x844'] = process.argv.slice(2);
const ROOT = resolve(distArg ?? 'dist') + sep;
const OUT = resolve('docs/shots');
const PORT = 4338;
const require = createRequire(import.meta.url);
// Supports both a mailbox script and a script installed in the game project.
const { chromium } = require(require.resolve('playwright', { paths: [ROOT, process.cwd(), import.meta.dirname] }));
const WARMUP_MS = 3000;
const MEASURE_MS = 60000;
const VIEWPORTS = [
  { id: '390x844', width: 390, height: 844, dpr: 2, touch: true },
  { id: '1280x800', width: 1280, height: 800, dpr: 1, touch: false },
];
const v = VIEWPORTS.find((v) => v.id === viewportId);
if (!v) throw new Error(`Unknown viewport "${viewportId}"; use 390x844 or 1280x800.`);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};
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

let browser;
let watchdog;
try {
  await new Promise((r, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', r);
  });
  await mkdir(OUT, { recursive: true });
  browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const context = await browser.newContext({
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.dpr,
    hasTouch: v.touch,
    isMobile: v.touch,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.tinyRoadHopper?.frames > 2);
  console.log(`${v.id} DPR${v.dpr}: headless Chromium on ${platform()}/${arch()}, emulated viewport; NOT a physical phone. Warming up 3s, sampling 60s.`);

  const raw = await Promise.race([
    page.evaluate(
      ({ warmup, measure }) =>
        new Promise((done) => {
          const g = window.tinyRoadHopper;
          g.restart(); // Fresh load seed 1; ONE restart => seed 1015568748.
          const intervals = [];
          const heap = [];
          const recoveries = [];
          const cycles = [];
          let stopped = false;
          let seed = 1015568748;
          let observedNonPlayingFrames = 0;
          const t0 = performance.now();
          let sampleStart = null;
          let last = null;
          let nonPlayingFrames = 0;
          let hiddenFrames = 0;

          const sampleHeap = (label, now) => heap.push({
            label,
            elapsedMs: +(now - sampleStart).toFixed(2),
            usedJSHeapSize: performance.memory?.usedJSHeapSize ?? null,
          });

          // Copied from tiny-road-hopper/scripts/shots.mjs: same public-input
          // pilot and hazard geometry. Each invocation owns one run only.
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

          const playContinuously = async () => {
            while (!stopped) {
              const result = await pilot(14);
              if (stopped) return;
              const now = performance.now();
              const event = {
                elapsedMs: +(now - t0).toFixed(2),
                stage: sampleStart === null ? 'warmup' : 'sample',
                phase: g.state.phase,
                seed,
                ...result,
              };
              // Record failures even if the sampler never sees the over screen
              // between this pilot's callback and the synchronous restart.
              if (!result.alive || result.cause) recoveries.push(event);
              else cycles.push(event);
              g.restart();
              seed = (seed * 1664525 + 1013904223) >>> 0 || 1;
            }
          };
          void playContinuously();

          const tick = (now) => {
            // Start on a frame boundary after warm-up. The first interval is
            // entirely inside sampling, with no warm-up interval mixed in.
            if (sampleStart === null && now - t0 >= warmup) {
              sampleStart = now;
              sampleHeap('start', now);
            }
            const measuring = sampleStart !== null;
            if (measuring && last !== null) intervals.push(now - last);
            if (measuring) last = now;

            if (g.state.phase !== 'playing') {
              observedNonPlayingFrames++;
              if (measuring) nonPlayingFrames++;
            }
            if (measuring && document.hidden) hiddenFrames++;
            if (measuring && heap.length === 1 && now - sampleStart >= measure / 2) sampleHeap('middle', now);
            if (measuring && now - sampleStart >= measure) {
              sampleHeap('end', now);
              stopped = true;
              return done({ intervals, heap, recoveries, cycles, nonPlayingFrames,
                observedNonPlayingFrames, hiddenFrames, finalPhase: g.state.phase,
                finalRow: g.state.player.row, finalSeed: seed });
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      { warmup: WARMUP_MS, measure: MEASURE_MS },
    ),
    new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('INVALID: frame sampler did not finish within 100s.')), 100000);
    }),
  ]);
  clearTimeout(watchdog);
  const iv = raw.intervals.slice().sort((a, b) => a - b);
  const q = (p) => +iv[Math.min(iv.length - 1, Math.floor(iv.length * p))].toFixed(2);
  const invalidReasons = [];
  if (raw.nonPlayingFrames) invalidReasons.push(`${raw.nonPlayingFrames} sampled non-playing frames`);
  if (raw.recoveries.length) invalidReasons.push(`${raw.recoveries.length} unexpected pilot deaths/timeouts (including warm-up)`);
  if (raw.hiddenFrames) invalidReasons.push(`${raw.hiddenFrames} sampled hidden-page frames`);
  if (errors.length) invalidReasons.push(`${errors.length} page/console errors`);
  const summary = {
    valid: invalidReasons.length === 0,
    invalidReasons,
    note: 'Headless Chromium via Playwright on the host; emulated viewport, NOT a physical phone. Frame intervals are requestAnimationFrame cadence, not presentation timing or an FPS guarantee.',
    host: { platform: platform(), arch: arch() },
    chromiumVersion: browser.version(),
    dist: ROOT,
    recordedAt: new Date().toISOString(),
    viewport: v,
    initialSeed: 1015568748,
    warmupMs: WARMUP_MS,
    requestedSampleMs: MEASURE_MS,
    frames: iv.length,
    seconds: +(raw.intervals.reduce((a, b) => a + b, 0) / 1000).toFixed(3),
    intervalMs: { min: q(0), p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: q(1) },
    countOver16_7ms: iv.filter((x) => x > 16.7).length,
    countOver33ms: iv.filter((x) => x > 33).length,
    pilotTargetRow: 14,
    seedPolicy: 'Fresh load seed 1; initial restart gives 1015568748. Every planned cycle or recovery advances the same LCG; timing and death can change the sampled scenes.',
    restarts: raw.cycles.length + raw.recoveries.length,
    plannedRestarts: raw.cycles.length,
    cycles: raw.cycles,
    finalPhase: raw.finalPhase,
    finalRow: raw.finalRow,
    finalSeed: raw.finalSeed,
    observedNonPlayingFrames: raw.observedNonPlayingFrames,
    recoveries: raw.recoveries,
    nonPlayingFrames: raw.nonPlayingFrames,
    hiddenFrames: raw.hiddenFrames,
    heap: {
      note: 'Chromium-only performance.memory.usedJSHeapSize, bytes; GC can make this fluctuate. Null means unavailable; this is not total process memory.',
      samples: raw.heap,
      endMinusStartBytes: raw.heap.every((s) => s.usedJSHeapSize !== null)
        ? raw.heap[2].usedJSHeapSize - raw.heap[0].usedJSHeapSize : null,
    },
    intervalsMs: raw.intervals,
    errors,
  };
  const file = join(OUT, `perf-${v.id}.json`);
  await writeFile(file, JSON.stringify(summary, null, 2) + '\n');
  const ms = summary.intervalMs;
  console.log(`${summary.valid ? 'VALID' : 'INVALID'} ${v.id}: ${summary.frames} intervals / ${summary.seconds}s; ms min/p50/p95/p99/max=${ms.min}/${ms.p50}/${ms.p95}/${ms.p99}/${ms.max}; >16.7ms=${summary.countOver16_7ms}; >33ms=${summary.countOver33ms}; restarts=${summary.restarts}`);
  console.log(`JS heap (Chromium-only bytes) start/middle/end=${raw.heap.map((s) => s.usedJSHeapSize ?? 'unavailable').join('/')}; delta=${summary.heap.endMinusStartBytes ?? 'unavailable'}`);
  for (const r of raw.recoveries) console.log(`  ! restarted during ${r.stage} at ${r.elapsedMs}ms: ${r.phase}, cause=${r.cause}, row=${r.row}`);
  if (!summary.valid) console.log(`  ! INVALID: ${invalidReasons.join('; ')}. Distribution retained for diagnosis only.`);
  console.log(`wrote ${file}`);
  console.log(`final phase=${summary.finalPhase}, row=${summary.finalRow}; planned cycles=${summary.plannedRestarts}; unexpected recoveries=${raw.recoveries.length}; non-playing sampled frames=${summary.nonPlayingFrames}`);
} finally {
  clearTimeout(watchdog);
  if (browser) await browser.close();
  if (server.listening) await new Promise((r) => server.close(r));
}
