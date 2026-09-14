/**
 * Browser smoke test: serves the production build, drives it in Chromium at a
 * desktop and an iPhone viewport, and asserts against the live simulation state
 * rather than pixels. Screenshots land in docs/.
 */
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const PORT = 4329;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
  // extname must run on the resolved file, not the URL: '/' has no extension and
  // an octet-stream index page makes Chromium download instead of render it.
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await mkdir(new URL('../docs/', import.meta.url).pathname, { recursive: true });
const browser = await chromium.launch();

/** Turn the whole live board into safe grass so control checks are not cut
 *  short by real traffic, and hold the hawk back. */
const pave = (page) =>
  page.evaluate(() => {
    const g = window.tinyRoadHopper;
    for (const row of g.state.rows) {
      row.kind = 'grass';
      row.movers = [];
      row.blockers = [];
      row.coinCol = null;
      row.train = 'idle';
      row.speed = 0;
    }
    g.state.frontier = g.state.player.row - 5;
  });

async function run(label, contextOptions, shots) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.tinyRoadHopper);

  const box = await page.locator('#scene').boundingBox();
  const vw = contextOptions.viewport.width;
  const vh = contextOptions.viewport.height;
  check(
    `${label}: canvas fills the viewport`,
    Math.abs(box.width - vw) < 2 && Math.abs(box.height - vh) < 2,
    `${Math.round(box.width)}x${Math.round(box.height)}`,
  );
  check(`${label}: start overlay visible`, await page.locator('#overlay').isVisible());
  await page.screenshot({ path: `docs/${shots.menu}` });

  await page.locator('#overlay-action').click();
  check(`${label}: overlay hidden after start`, await page.locator('#overlay').isHidden());

  // Let the real generated board run for a moment.
  await page.waitForTimeout(900);
  const snap = await page.evaluate(() => {
    const g = window.tinyRoadHopper;
    const kinds = {};
    for (const r of g.state.rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    return {
      kinds,
      rows: g.state.rows.length,
      movers: g.state.rows.reduce((n, r) => n + r.movers.length, 0),
      coins: g.state.rows.filter((r) => r.coinCol !== null).length,
      frontier: g.state.frontier,
      phase: g.state.phase,
    };
  });
  check(`${label}: board generated with roads, rivers and rails`,
    snap.kinds.road > 0 && snap.kinds.river > 0 && snap.kinds.grass > 0 && snap.movers > 5,
    `${JSON.stringify(snap.kinds)}, ${snap.movers} movers, ${snap.coins} coin rows`);
  // Poll the frame counter instead of asserting an absolute count: headless rAF
  // pacing varies with how many contexts are alive.
  const pair = await page.evaluate(async () => {
    const first = window.tinyRoadHopper.frames;
    await new Promise((r) => setTimeout(r, 300));
    return { first, second: window.tinyRoadHopper.frames };
  });
  check(`${label}: frames render`, pair.second > pair.first, `+${pair.second - pair.first} frames/300ms`);

  // Traffic actually moves: the stream phase has to advance.
  const traffic = await page.evaluate(async () => {
    const g = window.tinyRoadHopper;
    const road = g.state.rows.find((r) => r.kind === 'road' && r.movers.length);
    if (!road) return null;
    const before = road.phase;
    await new Promise((r) => setTimeout(r, 250));
    return { before, after: road.phase, dir: road.dir, speed: road.speed };
  });
  check(`${label}: traffic streams move`, traffic && traffic.before !== traffic.after,
    traffic ? `phase ${traffic.before.toFixed(2)} -> ${traffic.after.toFixed(2)} @ ${traffic.speed.toFixed(1)} t/s` : 'no road row');

  check(`${label}: canvas renders a non-empty scene`,
    await page.evaluate(() => {
      const c = document.getElementById('scene');
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < px.length; i += 4000) if (px[i] > 8) lit++;
      return lit > 100;
    }));
  await page.screenshot({ path: `docs/${shots.play}` });

  await pave(page);

  // Grid movement in all four directions.
  const before = await page.evaluate(() => ({ ...window.tinyRoadHopper.state.player }));
  await page.keyboard.press('ArrowUp');
  const up = await page.waitForFunction((r) => window.tinyRoadHopper.state.player.row === r + 1 && !window.tinyRoadHopper.state.player.hop, before.row, { timeout: 2000 })
    .then(() => true).catch(() => false);
  check(`${label}: up key hops one row forward`, up);
  await page.keyboard.press('ArrowRight');
  const right = await page.waitForFunction(() => Math.round(window.tinyRoadHopper.state.player.x) === 1 && !window.tinyRoadHopper.state.player.hop, null, { timeout: 2000 })
    .then(() => true).catch(() => false);
  check(`${label}: right key hops one column`, right);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown');
  const back = await page.waitForFunction((r) => {
    const p = window.tinyRoadHopper.state.player;
    return !p.hop && p.row === r && Math.round(p.x) === 0;
  }, before.row + 1 - 1, { timeout: 2500 }).then(() => true).catch(() => false);
  check(`${label}: left and down hop back to the start cell`, back);

  // The hop is an arc, not a teleport.
  const arc = await page.evaluate(async () => {
    const g = window.tinyRoadHopper;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));
    const mid = g.state.player.hop ? { t: g.state.player.hop.t, toRow: g.state.player.hop.toRow } : null;
    await new Promise((r) => setTimeout(r, 250));
    return { mid, landed: g.state.player.hop === null, row: g.state.player.row };
  });
  check(`${label}: hop animates then lands`, arc.mid !== null && arc.mid.t < 1 && arc.landed, `mid t=${arc.mid?.t?.toFixed(2)}`);

  // Static scenery refuses the hop.
  const bumped = await page.evaluate(async () => {
    const g = window.tinyRoadHopper;
    const p = g.state.player;
    const ahead = g.state.rows[p.row + 1 - g.state.firstRow];
    ahead.blockers = [{ col: Math.round(p.x), kind: 'tree', size: 1 }];
    const row = p.row;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));
    const bump = p.hop?.bump === true;
    await new Promise((r) => setTimeout(r, 250));
    ahead.blockers = [];
    return { bump, moved: g.state.player.row !== row };
  });
  check(`${label}: a tree blocks the hop`, bumped.bump && !bumped.moved);

  // Traffic kills.
  const squashed = await page.evaluate(async () => {
    const g = window.tinyRoadHopper;
    const p = g.state.player;
    const row = g.state.rows[p.row - g.state.firstRow];
    row.kind = 'road';
    row.speed = 0;
    row.phase = 0;
    row.dir = 1;
    row.movers = [{ p: p.x, w: 1.7, kind: 'car', tint: 0.1 }];
    await new Promise((r) => setTimeout(r, 200));
    return { phase: g.state.phase, cause: g.state.cause };
  });
  check(`${label}: traffic ends the run`, squashed.phase === 'over' && /car/.test(squashed.cause ?? ''), squashed.cause);
  check(`${label}: game-over overlay shown`, await page.locator('#overlay').isVisible());
  await page.screenshot({ path: `docs/${shots.over}` });

  // Restart resets the run.
  await page.locator('#overlay-action').click();
  const freshState = await page.evaluate(() => {
    const g = window.tinyRoadHopper;
    return { phase: g.state.phase, row: g.state.player.row, x: g.state.player.x, coins: g.state.coins, score: g.state.score, hops: g.state.hops };
  });
  check(`${label}: restart resets state`,
    freshState.phase === 'playing' && freshState.row === 0 && freshState.x === 0 &&
      freshState.coins === 0 && freshState.score === 0 && freshState.hops === 0,
    JSON.stringify(freshState));

  // Scoring: distance drives the score, coins add a bonus.
  await pave(page);
  const scored = await page.evaluate(async () => {
    const g = window.tinyRoadHopper;
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));
      await new Promise((r) => setTimeout(r, 170));
    }
    const rows = g.state.maxRow;
    const scoreByRows = g.state.score;
    const row = g.state.rows[g.state.player.row - g.state.firstRow];
    row.coinCol = Math.round(g.state.player.x);
    row.coinTaken = false;
    await new Promise((r) => setTimeout(r, 120));
    return { rows, scoreByRows, coins: g.state.coins, score: g.state.score, hud: document.getElementById('score').textContent, hudRows: document.getElementById('rows').textContent };
  });
  check(`${label}: score tracks rows crossed`, scored.rows === 3 && scored.scoreByRows === 3, `${scored.rows} rows -> ${scored.scoreByRows}`);
  check(`${label}: coin adds a 3 point bonus`, scored.coins === 1 && scored.score === scored.rows + 3, `score=${scored.score}`);
  check(`${label}: HUD mirrors the simulation`, scored.hud === String(scored.score) && scored.hudRows === String(scored.rows), `hud=${scored.hud}/${scored.hudRows}`);

  // River: land on a log, ride it, then drown in open water.
  const river = await page.evaluate(async () => {
    const g = window.tinyRoadHopper;
    const p = g.state.player;
    const ahead = g.state.rows[p.row + 1 - g.state.firstRow];
    ahead.kind = 'river';
    ahead.dir = 1;
    ahead.speed = 2;
    ahead.phase = 0;
    ahead.movers = [{ p: Math.round(p.x), w: 4, kind: 'log', tint: 0 }];
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));
    await new Promise((r) => setTimeout(r, 200));
    const onLog = { riding: g.state.player.ridingLog, x: g.state.player.x, phase: g.state.phase };
    await new Promise((r) => setTimeout(r, 300));
    const drifted = g.state.player.x !== onLog.x;
    // Now remove the platform under it: open water drowns.
    ahead.movers = [];
    await new Promise((r) => setTimeout(r, 150));
    return { onLog, drifted, phase: g.state.phase, cause: g.state.cause };
  });
  check(`${label}: hopper boards a log`, river.onLog.riding === 0 && river.onLog.phase === 'playing', `ridingLog=${river.onLog.riding}`);
  check(`${label}: the log carries the hopper`, river.drifted);
  check(`${label}: open water drowns the hopper`, river.phase === 'over' && /river/.test(river.cause ?? ''), river.cause);

  // Train: warning first, then lethal.
  await page.locator('#overlay-action').click();
  await pave(page);
  await page.evaluate(() => {
    const g = window.tinyRoadHopper;
    const row = g.state.rows[g.state.player.row - g.state.firstRow];
    row.kind = 'rail';
    row.dir = 1;
    row.train = 'idle';
    row.trainTimer = 0.05;
  });
  // Poll for the warn state: headless rAF pacing is far below 60fps, so a fixed
  // sleep can land before the first simulation tick has even run.
  const warned = await page
    .waitForFunction(() => {
      const g = window.tinyRoadHopper;
      const row = g.state.rows[g.state.player.row - g.state.firstRow];
      if (!row || row.train !== 'warn') return null;
      return { alive: g.state.phase === 'playing', callout: document.getElementById('callout').textContent, trainX: row.trainX };
    }, null, { timeout: 4000 })
    .then((h) => h.jsonValue())
    .catch(() => null);
  check(`${label}: train warns before it arrives`, !!warned && warned.alive, warned ? `callout="${warned.callout}", train off-field at x=${warned.trainX.toFixed(1)}` : 'never reached warn');
  const train = await page
    .waitForFunction(() => (window.tinyRoadHopper.state.phase === 'over' ? { cause: window.tinyRoadHopper.state.cause } : null), null, { timeout: 8000 })
    .then((h) => h.jsonValue())
    .catch(() => ({ cause: 'timed out waiting for the train' }));
  check(`${label}: the train then kills on the tracks`, /tracks/.test(train.cause ?? ''), train.cause);

  // The hawk catches a hopper that stalls.
  await page.locator('#overlay-action').click();
  await pave(page);
  const hawk = await page.evaluate(async () => {
    const g = window.tinyRoadHopper;
    const el = document.getElementById('danger');
    // Sample the gauge while the hopper is still alive but nearly caught: the
    // critical class is cleared again the moment the phase leaves 'playing'.
    g.state.frontier = g.state.player.row - 1;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const gauge = { cls: el.className, fill: el.style.getPropertyValue('--fill'), phase: g.state.phase };
    g.state.frontier = g.state.player.row + 0.05;
    await new Promise((r) => setTimeout(r, 250));
    return { phase: g.state.phase, cause: g.state.cause, gauge };
  });
  check(`${label}: danger gauge warns while critical`,
    hawk.gauge.phase === 'playing' && /critical/.test(hawk.gauge.cls) && parseFloat(hawk.gauge.fill) < 34,
    `class="${hawk.gauge.cls}" fill=${hawk.gauge.fill}`);
  check(`${label}: falling behind the frontier ends the run`, hawk.phase === 'over' && /hawk/.test(hawk.cause ?? ''), hawk.cause);

  // Best score survives a run.
  const best = await page.evaluate(() => Number(localStorage.getItem('tiny-road-hopper:best')));
  check(`${label}: best score persisted`, best > 0, `best=${best}`);

  // Pause / resume freezes the world.
  await page.locator('#overlay-action').click();
  await pave(page);
  await page.keyboard.press('KeyP');
  const paused = await page.evaluate(async () => {
    const g = window.tinyRoadHopper;
    const f = g.state.frontier;
    await new Promise((r) => setTimeout(r, 350));
    return { phase: g.state.phase, frozen: Math.abs(g.state.frontier - f) < 1e-9, overlay: !document.getElementById('overlay').classList.contains('hidden') };
  });
  check(`${label}: pause freezes the simulation`, paused.phase === 'paused' && paused.frozen && paused.overlay);
  await page.locator('#overlay-action').click();
  check(`${label}: resume continues the run`, (await page.evaluate(() => window.tinyRoadHopper.state.phase)) === 'playing');

  // Touch controls on the mobile pass: a real swipe must hop.
  if (contextOptions.hasTouch) {
    await pave(page);
    const startRow = await page.evaluate(() => window.tinyRoadHopper.state.player.row);
    const cx = Math.round(vw / 2);
    const cy = Math.round(vh * 0.6);
    await page.touchscreen.tap(cx, cy);
    const tapped = await page.waitForFunction((r) => window.tinyRoadHopper.state.player.row === r + 1, startRow, { timeout: 2000 })
      .then(() => true).catch(() => false);
    check(`${label}: tap hops forward`, tapped);
    await page.evaluate(async ({ cx, cy }) => {
      const el = document.getElementById('scene');
      const mk = (type, x, y) => {
        const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        el.dispatchEvent(new TouchEvent(type, { changedTouches: [t], touches: type === 'touchend' ? [] : [t], bubbles: true, cancelable: true }));
      };
      mk('touchstart', cx, cy);
      mk('touchmove', cx + 70, cy);
      mk('touchend', cx + 70, cy);
      await new Promise((r) => setTimeout(r, 200));
    }, { cx, cy });
    const swiped = await page.evaluate(() => Math.round(window.tinyRoadHopper.state.player.x));
    check(`${label}: swipe right hops sideways`, swiped === 1, `x=${swiped}`);

    // A cancelled touch must not stay armed. The browser takes a touch away
    // without a touchend (scroll takeover, call banner, app switch); if the
    // gesture is still held, the next unrelated touchmove completes it as a
    // hop the player never asked for.
    await pave(page);
    const held = await page.evaluate(async ({ cx, cy }) => {
      const el = document.getElementById('scene');
      const mk = (type, x, y) => {
        const t = new Touch({ identifier: 2, target: el, clientX: x, clientY: y });
        el.dispatchEvent(new TouchEvent(type, { changedTouches: [t], touches: type === 'touchcancel' ? [] : [t], bubbles: true, cancelable: true }));
      };
      const before = { x: window.tinyRoadHopper.state.player.x, row: window.tinyRoadHopper.state.player.row };
      mk('touchstart', cx, cy);
      mk('touchcancel', cx, cy);
      // Far enough to clear SWIPE_MIN had the gesture survived the cancel.
      mk('touchmove', cx + 90, cy);
      await new Promise((r) => setTimeout(r, 250));
      const after = window.tinyRoadHopper.state.player;
      return { before, x: after.x, row: after.row, hop: !!after.hop };
    }, { cx, cy });
    check(
      `${label}: a cancelled touch does not fire a stale hop`,
      Math.round(held.x) === Math.round(held.before.x) && held.row === held.before.row && !held.hop,
      `x=${held.x} row=${held.row} hop=${held.hop}`,
    );

    // Same contract for a window blur mid-gesture.
    await pave(page);
    const blurred = await page.evaluate(async ({ cx, cy }) => {
      const el = document.getElementById('scene');
      const mk = (type, x, y) => {
        const t = new Touch({ identifier: 3, target: el, clientX: x, clientY: y });
        el.dispatchEvent(new TouchEvent(type, { changedTouches: [t], touches: [t], bubbles: true, cancelable: true }));
      };
      const before = { x: window.tinyRoadHopper.state.player.x, row: window.tinyRoadHopper.state.player.row };
      mk('touchstart', cx, cy);
      window.dispatchEvent(new Event('blur'));
      mk('touchmove', cx + 90, cy);
      await new Promise((r) => setTimeout(r, 250));
      const after = window.tinyRoadHopper.state.player;
      return { before, x: after.x, row: after.row };
    }, { cx, cy });
    check(
      `${label}: a blur mid-gesture does not fire a stale hop`,
      Math.round(blurred.x) === Math.round(blurred.before.x) && blurred.row === blurred.before.row,
      `x=${blurred.x} row=${blurred.row}`,
    );
  }

  // Mute toggle
  await page.locator('#mute-btn').click();
  check(`${label}: mute toggles and persists`,
    (await page.locator('#mute-btn').getAttribute('aria-pressed')) === 'true' &&
      (await page.evaluate(() => localStorage.getItem('tiny-road-hopper:muted'))) === '1');
  await page.locator('#mute-btn').click();

  check(`${label}: no console or page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

await run('desktop', { viewport: { width: 1280, height: 800 } }, {
  menu: 'screenshot-desktop-menu.png',
  play: 'screenshot-desktop-play.png',
  over: 'screenshot-desktop-gameover.png',
});
await run('mobile', { ...devices['iPhone 13'], isMobile: true, hasTouch: true }, {
  menu: 'screenshot-mobile-menu.png',
  play: 'screenshot-mobile-play.png',
  over: 'screenshot-mobile-gameover.png',
});

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
