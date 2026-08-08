// Capture runner: drives agent-browser through a demo script, records a
// cursorless WebM, and emits the timeline the Remotion renderer consumes.
// Runs inside the worker sandbox (agent-browser + ffmpeg present).
//
// The key idea: the runner performs the real interactions AND logs, for the
// same clock, where the (synthetic) cursor is, when clicks land, and the
// resolved rect of each target. Effects and capture come from one script, so
// a zoom can never drift from the element it is zooming to.
//
// Usage: SCRIPT=/path/to/demo-script.json OUT_DIR=/tmp/feature-demo/work \
//          node capture.mjs
// See SKILL.md for the demo-script schema.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const AB = process.env.AGENT_BROWSER_BIN || 'agent-browser';
const OUT_DIR = process.env.OUT_DIR || '/tmp/feature-demo/work';

const SCRIPT_PATH = process.env.SCRIPT;

if (!SCRIPT_PATH) {
  console.error('Set SCRIPT to the demo-script JSON path.');
  process.exit(1);
}

const script = JSON.parse(readFileSync(SCRIPT_PATH, 'utf8'));

if (!script.url || !Array.isArray(script.beats)) {
  console.error('Demo script must have { url, beats: [...] }.');
  process.exit(1);
}

const VIEWPORT = script.viewport || { w: 1280, h: 800 };

// Between focus beats the camera pulls back only partially; pogo-ing to full
// wide between every zoom reads as jumpy. The final reset goes fully wide.
const GLIDE_SCALE = 1.18;

const ab = (...args) =>
  execFileSync(AB, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const sleep = (ms) => execFileSync('sleep', [String(ms / 1000)]);

let t0 = 0;
const now = () => (Date.now() - t0) / 1000; // seconds since record start

function rect(sel) {
  // The selector travels into the page-eval as base64 so no selector bytes
  // are ever interpolated into code; the alphabet check makes that a hard
  // guarantee rather than an encoding assumption.
  const selB64 = Buffer.from(String(sel), 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(selB64)) {
    throw new Error(`unencodable selector: ${sel}`);
  }
  const js =
    `(function(){var e=document.querySelector(atob("${selB64}"));` +
    `if(!e)return null;var r=e.getBoundingClientRect();` +
    `return{x:r.x,y:r.y,w:r.width,h:r.height};})()`;
  const out = ab('eval', js).trim();
  const r = JSON.parse(out);
  if (!r) throw new Error(`element not found: ${sel}`);
  return r;
}

const centerNorm = (r) => ({
  x: (r.x + r.w / 2) / VIEWPORT.w,
  y: (r.y + r.h / 2) / VIEWPORT.h,
});

const timeline = {
  video: { path: 'recording.mp4', width: VIEWPORT.w, height: VIEWPORT.h },
  fps: 30,
  durationSeconds: 0,
  scaleKeys: [{ t: 0, v: 1 }],
  focalKeys: [{ t: 0, v: { x: 0.5, y: 0.5 } }],
  cursorKeys: [{ t: 0, v: { x: 0.5, y: 1.1 } }],
  clicks: [],
  captions: [],
};

let cur = { scale: 1, focal: { x: 0.5, y: 0.5 } };
// Track the cursor so motion can be bracketed by a hold key: the renderer
// eases between consecutive keys, so without a hold at motion start the
// synthetic cursor would drift toward the next target through every wait,
// hold, and scroll in between while the real mouse is stationary.
let curCursor = { x: 0.5, y: 1.1 };
const pushScale = (t, v) => timeline.scaleKeys.push({ t, v });
const pushFocal = (t, v) => timeline.focalKeys.push({ t, v });
const pushCursorMove = (startT, endT, target) => {
  timeline.cursorKeys.push({ t: startT, v: curCursor });
  timeline.cursorKeys.push({ t: endT, v: target });
  curCursor = target;
};

async function run() {
  mkdirSync(OUT_DIR, { recursive: true });
  ab('set', 'viewport', String(VIEWPORT.w), String(VIEWPORT.h));
  ab('record', 'start', `${OUT_DIR}/raw.webm`, script.url);
  t0 = Date.now();
  sleep(300); // let the first frames settle

  for (const beat of script.beats) {
    if (beat.a === 'hold' || beat.a === 'wait') {
      sleep(beat.ms);
      continue;
    }

    if (beat.a === 'scrollTo') {
      ab('scrollintoview', beat.sel);
      sleep(beat.ms ?? 650); // let the scroll settle (shows in the recording)
      continue;
    }

    if (beat.a === 'focus') {
      const c = centerNorm(rect(beat.sel));
      const start = now();
      pushScale(start, cur.scale);
      pushFocal(start, cur.focal);
      // Real hover so the app's hover state shows under the synthetic cursor.
      ab(
        'mouse',
        'move',
        String((c.x * VIEWPORT.w) | 0),
        String((c.y * VIEWPORT.h) | 0),
      );
      sleep(beat.moveMs ?? 700); // pace the glide for the eased cursor
      const end = now();
      pushScale(end, beat.scale ?? 1.5);
      pushFocal(end, c);
      pushCursorMove(start, end, c);
      if (beat.caption) {
        timeline.captions.push({
          start: start + 0.15,
          end: end + (beat.holdMs ?? 900) / 1000,
          text: beat.caption,
        });
      }
      cur = { scale: beat.scale ?? 1.5, focal: c };
      sleep(beat.holdMs ?? 900);
      continue;
    }

    if (beat.a === 'click') {
      const c = centerNorm(rect(beat.sel));
      const t = now();
      timeline.clicks.push({ t, at: c });
      // Usually the cursor is already here from a preceding focus; when it
      // is not, give it a short bracketed hop instead of a slow drift.
      if (curCursor.x !== c.x || curCursor.y !== c.y) {
        pushCursorMove(Math.max(0, t - 0.25), t, c);
      }
      ab('click', beat.sel);
      sleep(beat.holdMs ?? 300);
      continue;
    }

    if (beat.a === 'type') {
      ab('type', beat.sel, beat.text);
      continue;
    }

    if (beat.a === 'reset') {
      // Partial pull-back keeps the camera alive between beats; `full: true`
      // (or the closing reset) returns to wide.
      const target = beat.full ? 1 : GLIDE_SCALE;
      const start = now();
      pushScale(start, cur.scale);
      pushFocal(start, cur.focal);
      sleep(beat.ms ?? 600);
      const end = now();
      pushScale(end, target);
      pushFocal(end, { x: 0.5, y: 0.5 });
      cur = { scale: target, focal: { x: 0.5, y: 0.5 } };
      continue;
    }

    throw new Error(`unknown beat action: ${beat.a}`);
  }

  // Close on a full wide shot even when the script forgot a final reset.
  if (cur.scale !== 1) {
    const start = now();
    pushScale(start, cur.scale);
    pushFocal(start, cur.focal);
    sleep(600);
    const end = now();
    pushScale(end, 1);
    pushFocal(end, { x: 0.5, y: 0.5 });
  }

  timeline.durationSeconds = now();
  ab('record', 'stop');
  try {
    ab('close', '--all');
  } catch {
    // best-effort; the recording is already on disk
  }

  // WebM (VP8/VP9) -> H.264 mp4 for the renderer.
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      `${OUT_DIR}/raw.webm`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      `${OUT_DIR}/recording.mp4`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  writeFileSync(`${OUT_DIR}/timeline.json`, JSON.stringify(timeline, null, 2));
  console.log(
    `captured: duration=${timeline.durationSeconds.toFixed(2)}s ` +
      `clicks=${timeline.clicks.length} captions=${timeline.captions.length} ` +
      `cursorKeys=${timeline.cursorKeys.length}`,
  );
}

run().catch((e) => {
  console.error('capture failed:', e.message);
  process.exit(1);
});
