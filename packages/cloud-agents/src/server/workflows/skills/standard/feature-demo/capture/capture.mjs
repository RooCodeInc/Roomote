// Capture runner: drives agent-browser through a demo script, records a
// cursorless WebM, and emits the timeline the Remotion renderer consumes.
// Runs inside the worker sandbox (agent-browser + ffmpeg present).
//
// Two ideas make the output polished:
// 1. The runner performs the real interactions AND logs, for the same clock,
//    where the (synthetic) cursor is and when clicks land.
// 2. The NARRATIVE drives the visuals: each captioned beat holds for as long
//    as its line takes to speak (the real clip duration when narration was
//    synthesized before capture; an estimated speaking time for the caption
//    text otherwise), and the runner stamps each clip's start as its visual
//    settles. Nothing needs retiming afterwards.
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

const SUPPORTED_ACTIONS = new Set([
  'show',
  'wait',
  'hold',
  'scrollTo',
  'click',
  'type',
]);
const unsupportedBeat = script.beats.find(
  (beat) => !SUPPORTED_ACTIONS.has(beat.a),
);

if (unsupportedBeat) {
  console.error(`unknown beat action: ${unsupportedBeat.a}`);
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

// Breathing room after a line ends before the next beat's motion begins.
const LINE_GAP = 0.35;

// Estimated speaking time for captions-only pacing: ~2.8 words/second,
// clamped so terse lines still get a beat and very long ones don't stall.
function estimateSpokenSeconds(text) {
  const words = String(text).trim().split(/\s+/).length;
  return Math.min(10, Math.max(1.8, words / 2.8));
}

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

// Full normalized bounding box — the anchor for annotations. Resolved AFTER
// the beat's scroll settles, because rects are viewport-relative: an anchor
// is only valid for the scroll position it was measured at, which is why
// annotations live strictly inside their beat's window.
const boxNorm = (r) => ({
  x: r.x / VIEWPORT.w,
  y: r.y / VIEWPORT.h,
  w: r.w / VIEWPORT.w,
  h: r.h / VIEWPORT.h,
});

// Tight content rect for annotation anchors. Block elements (headings,
// paragraphs) report full-column boxes with dead space past the text; a
// Range over the contents hugs what the viewer actually reads. Falls back
// to the element box for empty/replaced elements.
function tightRect(sel) {
  const selB64 = Buffer.from(String(sel), 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(selB64)) {
    throw new Error(`unencodable selector: ${sel}`);
  }
  const js =
    `(function(){var e=document.querySelector(atob("${selB64}"));` +
    `if(!e)return null;var r=e.getBoundingClientRect();` +
    `try{var g=document.createRange();g.selectNodeContents(e);` +
    `var t=g.getBoundingClientRect();` +
    `if(t&&t.width>1&&t.height>1)r=t;}catch(_){}` +
    `return{x:r.x,y:r.y,w:r.width,h:r.height};})()`;
  const out = ab('eval', js).trim();
  const r = JSON.parse(out);
  if (!r) throw new Error(`element not found: ${sel}`);
  return r;
}

const timeline = {
  video: { path: 'recording.mp4', width: VIEWPORT.w, height: VIEWPORT.h },
  fps: 30,
  durationSeconds: 0,
  cursorKeys: [{ t: 0, v: { x: 0.5, y: 1.1 } }],
  clicks: [],
  captions: [],
  annotations: [],
  // Optional declarative caption styling from the demo script (position,
  // accent, pill, sizeScale); the renderer merges it over preset defaults.
  ...(script.captionStyle ? { captionStyle: script.captionStyle } : {}),
};

// Narrative pacing state: which line is next, and when the previous one
// finishes, so consecutive lines never overlap even if beats land early.
let lineIndex = 0;
let prevLineEnd = 0;
// Track the cursor so motion can be bracketed by a hold key: the renderer
// eases between consecutive keys, so without a hold at motion start the
// synthetic cursor would drift toward the next target through every wait,
// hold, and scroll in between while the real mouse is stationary.
let curCursor = { x: 0.5, y: 1.1 };
const pushCursorMove = (startT, endT, target) => {
  timeline.cursorKeys.push({ t: startT, v: curCursor });
  timeline.cursorKeys.push({ t: endT, v: target });
  curCursor = target;
};

// Headless capture emits frames only on visual damage and stamps them
// without wall-clock gaps, so a static surface collapses into a sub-second
// video; an imperceptible 2px dot re-painting every animation frame keeps
// frames flowing at wall-clock rate.
const TICKER_JS =
  '(function(){var d=document.createElement("div");' +
  'd.style.cssText="position:fixed;left:0;bottom:0;width:2px;height:2px;' +
  'z-index:2147483647;pointer-events:none;background:#000;opacity:0.01";' +
  'document.body.appendChild(d);var f=0;' +
  '(function t(){d.style.opacity=(f++%2)?"0.02":"0.01";' +
  'requestAnimationFrame(t)})()})()';

async function run() {
  mkdirSync(OUT_DIR, { recursive: true });
  // Fully stop any existing agent-browser daemon before recording. `close`
  // (alias quit/exit) tears the daemon down; `close --all` alone only clears
  // sessions. This gives `record start` a clean slate so the beats and the
  // recorder share one page.
  try {
    ab('close');
  } catch {
    // no active daemon is fine
  }
  ab('set', 'viewport', String(VIEWPORT.w), String(VIEWPORT.h));
  ab('record', 'start', `${OUT_DIR}/raw.webm`, script.url);

  t0 = Date.now();
  ab('eval', TICKER_JS);
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
      // over it with the camera wide. No cursor glide is needed for a
      // non-interactive beat.
      ab('scrollintoview', beat.sel);
      sleep(beat.settleMs ?? 600); // scroll settles on screen
      const settled = now();

      // `note` rides the beat: a highlight box (plus optional label chip)
      // anchored to the beat's own element, shown for the beat's caption
      // window. One per beat — it is a clarity device, not a diagram.
      const noteBox = beat.note
        ? boxNorm(tightRect(beat.note.sel ?? beat.sel))
        : null;
      const pushNote = (start, end) => {
        if (!noteBox) return;
        timeline.annotations.push({
          start: Math.round(start * 1000) / 1000,
          end: Math.round(end * 1000) / 1000,
          box: noteBox,
          ...(beat.note.text ? { text: beat.note.text } : {}),
          style: beat.note.style ?? 'spotlight',
        });
      };

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

        // The note breathes with the caption: appears a beat after the line
        // starts (the voice names the subject, then the box lands on it).
        pushNote(lineStart + 0.35, lineEnd + 0.25);

        const holdSeconds = Math.max(0.5, lineEnd + LINE_GAP - now());
        sleep(holdSeconds * 1000);
      } else {
        const holdMs = beat.holdMs ?? 900;
        pushNote(settled + 0.15, settled + holdMs / 1000 + 0.6);
        sleep(holdMs);
      }
      continue;
    }

    if (beat.a === 'click') {
      const c = centerNorm(rect(beat.sel));
      const t = now();
      timeline.clicks.push({ t, at: c });
      // Give the pointer a short bracketed hop when it is not already on the
      // target while preserving the interaction cue.
      if (curCursor.x !== c.x || curCursor.y !== c.y) {
        pushCursorMove(Math.max(0, t - 0.25), t, c);
      }
      ab('click', beat.sel);
      sleep(beat.holdMs ?? 300);
      continue;
    }

    if (beat.a === 'type') {
      const c = centerNorm(rect(beat.sel));
      const moveStart = now();
      ab(
        'mouse',
        'move',
        String((c.x * VIEWPORT.w) | 0),
        String((c.y * VIEWPORT.h) | 0),
      );
      sleep(beat.moveMs ?? 450);
      const moveEnd = now();
      pushCursorMove(moveStart, moveEnd, c);
      ab('type', beat.sel, beat.text);
      continue;
    }

    throw new Error(`unknown beat action: ${beat.a}`);
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
        `sparse or the recorder stalled. A GPU-backed surface (WebGL/WebGPU, ` +
        `3D, games) does not present frames to the headless compositor and ` +
        `cannot be recorded here; report the surface as unrecordable. If ` +
        `\`record stop\` also reported an ffmpeg error, the sandbox runtime ` +
        `is likely a stale snapshot with an outdated ffmpeg. Either way this ` +
        `is a blocker; do not render.`,
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
    // Clip start times are now stamped at the moments their visuals settled;
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
