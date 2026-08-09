// Capture runner: drives agent-browser through a demo script, records a
// cursorless WebM, and emits the timeline the Remotion renderer consumes.
// Runs inside the worker sandbox (agent-browser + ffmpeg present).
//
// Two ideas make the output polished:
// 1. The runner performs the real interactions AND logs, for the same clock,
//    where the (synthetic) cursor is, when clicks land, and the resolved
//    rect of each target — so a zoom can never drift from its element.
// 2. The NARRATIVE drives the visuals: each captioned beat holds for as long
//    as its line takes to speak (the real clip duration when narration was
//    synthesized before capture; an estimated speaking time for the caption
//    text otherwise), and the runner stamps each clip's start at the moment
//    its zoom actually lands. Nothing needs retiming afterwards.
//
// Usage: SCRIPT=/path/to/demo-script.json OUT_DIR=/tmp/feature-demo/work \
//          node capture.mjs
// Reads narration.json (written by build-narration.mjs before capture) from
// the script's directory when present. See SKILL.md for the schema.

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

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

// Narration manifest (pre-capture synthesis). Optional: without it the demo
// is captions-only and lines are paced by estimated speaking time.
const NARRATION_PATH =
  process.env.NARRATION || `${dirname(SCRIPT_PATH)}/narration.json`;
const narration = existsSync(NARRATION_PATH)
  ? JSON.parse(readFileSync(NARRATION_PATH, 'utf8'))
  : null;

const captionedBeatCount = script.beats.filter((b) => b.caption).length;

if (narration && narration.clips.length !== captionedBeatCount) {
  console.error(
    `narration.json has ${narration.clips.length} clips but the script has ` +
      `${captionedBeatCount} captioned beats; they must match 1:1 in order.`,
  );
  process.exit(1);
}

// The voice starts just before its zoom lands, then speaks over the hold.
const VOICE_LEAD = 0.4;
// Breathing room after a line ends before the next beat's motion begins.
const LINE_GAP = 0.35;

// Estimated speaking time for captions-only pacing: ~2.8 words/second,
// clamped so terse lines still get a beat and very long ones don't stall.
function estimateSpokenSeconds(text) {
  const words = String(text).trim().split(/\s+/).length;
  return Math.min(10, Math.max(1.8, words / 2.8));
}

// Between focus beats the camera pulls back only partially; pogo-ing to full
// wide between every zoom reads as jumpy. Kept well below the renderer's
// cap on zoom (the largest scale that keeps the whole window on the stage,
// about 1.16 for a wide demo with captions) so a following focus beat still
// reads as a distinct push-in rather than matching the glide. The final
// reset goes fully wide.
const GLIDE_SCALE = 1.06;

// Headless by default: with the frame ticker it records deterministically at
// wall-clock rate on ordinary pages. Headed mode (auto-Xvfb) exists for
// GPU-backed canvases (games, 3D, WebGL/WebGPU) that never present to the
// headless compositor — opt in per demo with `"headed": true` in the script
// (or HEADED=1). Note: current agent-browser headed recording can wedge the
// daemon on longer sessions; use it only when the surface requires it.
const HEADED = script.headed === true || process.env.HEADED === '1';

const ab = (...args) =>
  execFileSync(AB, HEADED ? ['--headed', ...args] : args, {
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
  // Optional declarative caption styling from the demo script (position,
  // accent, pill, sizeScale); the renderer merges it over preset defaults.
  ...(script.captionStyle ? { captionStyle: script.captionStyle } : {}),
};

let cur = { scale: 1, focal: { x: 0.5, y: 0.5 } };
// Narrative pacing state: which line is next, and when the previous one
// finishes, so consecutive lines never overlap even if beats land early.
let lineIndex = 0;
let prevLineEnd = 0;
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

// Headless (default) only: headless capture emits frames only on visual
// damage and stamps them without wall-clock gaps, so a static surface
// collapses into a sub-second video; an imperceptible 2px dot re-painting
// every animation frame keeps frames flowing at wall-clock rate. Headed
// mode presents at wall-clock rate on its own — verified on a fully static
// page — and skips the ticker.
const TICKER_JS =
  '(function(){var d=document.createElement("div");' +
  'd.style.cssText="position:fixed;left:0;bottom:0;width:2px;height:2px;' +
  'z-index:2147483647;pointer-events:none;background:#000;opacity:0.01";' +
  'document.body.appendChild(d);var f=0;' +
  '(function t(){d.style.opacity=(f++%2)?"0.02":"0.01";' +
  'requestAnimationFrame(t)})()})()';

async function run() {
  mkdirSync(OUT_DIR, { recursive: true });
  // Fully stop any existing agent-browser daemon before recording. `--headed`
  // (and other launch options) only take effect when the daemon launches the
  // browser; against an already-running daemon agent-browser prints
  // "--headed ignored: daemon already running" and records headless. `close`
  // (alias quit/exit) tears the daemon down; `close --all` alone only clears
  // sessions. This also gives `record start` a clean slate so the beats and
  // the recorder share one page.
  try {
    ab('close');
  } catch {
    // no active daemon is fine
  }
  ab('set', 'viewport', String(VIEWPORT.w), String(VIEWPORT.h));
  ab('record', 'start', `${OUT_DIR}/raw.webm`, script.url);

  // Verify the browser's actual mode positively rather than parsing daemon
  // warnings (the wrapper's cookie seeding or our own viewport call may have
  // launched the daemon first, which makes "--headed ignored" ambiguous).
  // Headless Chrome self-identifies in its user agent.
  if (HEADED) {
    const ua = ab('eval', 'navigator.userAgent');
    if (/HeadlessChrome/i.test(ua)) {
      throw new Error(
        'headed capture was requested but the browser is running headless ' +
          '(HeadlessChrome user agent) — an earlier browser step likely ' +
          'launched a headless daemon. Run `agent-browser close`, ensure ' +
          'nothing else drives the browser, and retry.',
      );
    }
  }
  t0 = Date.now();
  if (!HEADED) {
    ab('eval', TICKER_JS);
  }
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

    if (beat.a === 'show') {
      // The default narrated move: scroll the subject into view and speak
      // over it with the camera wide. No zoom, no cursor glide — zooming is
      // reserved for active interaction (focus before click/type).
      ab('scrollintoview', beat.sel);
      sleep(beat.settleMs ?? 600); // scroll settles on screen
      const settled = now();

      if (beat.caption) {
        const lineSeconds = narration
          ? narration.clips[lineIndex].durationSeconds
          : estimateSpokenSeconds(beat.caption);
        const lineStart =
          Math.round(Math.max(0.1, prevLineEnd + 0.1, settled - 0.15) * 1000) /
          1000;
        const lineEnd = lineStart + lineSeconds;
        prevLineEnd = lineEnd;

        timeline.captions.push({
          start: lineStart,
          end: Math.round((lineEnd + 0.25) * 1000) / 1000,
          text: beat.caption,
        });
        if (narration) {
          narration.clips[lineIndex].startSeconds = lineStart;
        }
        lineIndex += 1;

        const holdSeconds = Math.max(0.5, lineEnd + LINE_GAP - now());
        sleep(holdSeconds * 1000);
      } else {
        sleep(beat.holdMs ?? 900);
      }
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
      cur = { scale: beat.scale ?? 1.5, focal: c };

      if (beat.caption) {
        // The narrative drives the hold: the line starts just before the
        // zoom lands and the beat holds until it has been fully spoken,
        // plus breathing room. Script holdMs acts as a minimum only.
        const lineSeconds = narration
          ? narration.clips[lineIndex].durationSeconds
          : estimateSpokenSeconds(beat.caption);
        const lineStart =
          Math.round(Math.max(0.1, prevLineEnd + 0.1, end - VOICE_LEAD) * 1000) /
          1000;
        const lineEnd = lineStart + lineSeconds;
        prevLineEnd = lineEnd;

        timeline.captions.push({
          start: lineStart,
          end: Math.round((lineEnd + 0.25) * 1000) / 1000,
          text: beat.caption,
        });
        if (narration) {
          narration.clips[lineIndex].startSeconds = lineStart;
        }
        lineIndex += 1;

        const holdSeconds = Math.max(
          (beat.holdMs ?? 900) / 1000,
          lineEnd + LINE_GAP - now(),
        );
        sleep(holdSeconds * 1000);
      } else {
        sleep(beat.holdMs ?? 900);
      }
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

  // Honest-state gate: a recording much shorter than the interaction means
  // the screencast stalled (or frames stayed sparse despite the ticker) and
  // the demo would be garbage. Fail loudly instead of shipping it.
  const recordedSeconds = parseFloat(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      `${OUT_DIR}/raw.webm`,
    ])
      .toString()
      .trim(),
  );

  if (
    !Number.isFinite(recordedSeconds) ||
    recordedSeconds < timeline.durationSeconds * 0.75
  ) {
    throw new Error(
      `recording is ${recordedSeconds}s but the interaction ran ` +
        `${timeline.durationSeconds.toFixed(2)}s — screencast frames were ` +
        `sparse or the recorder stalled. If \`record stop\` also reported an ` +
        `ffmpeg error, the sandbox runtime is likely a stale snapshot with ` +
        `an outdated ffmpeg. Report this as a blocker; do not render.`,
    );
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
  if (narration) {
    // Clip start times are now stamped at the moments their zooms landed;
    // this manifest plus the vo/ mp3s next to the script is everything the
    // renderer needs.
    writeFileSync(
      `${OUT_DIR}/narration.json`,
      JSON.stringify(narration, null, 2),
    );
  }
  console.log(
    `captured: duration=${timeline.durationSeconds.toFixed(2)}s ` +
      `clicks=${timeline.clicks.length} captions=${timeline.captions.length} ` +
      `pacing=${narration ? 'narrated' : 'captions-only (estimated)'}`,
  );
}

run().catch((e) => {
  console.error('capture failed:', e.message);
  process.exit(1);
});
