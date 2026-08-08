// Post-capture timing fit. Takes the captured timeline plus the narration
// clips and produces the final pacing:
//
// 1. Trims the dead opening hold so the demo starts immediately.
// 2. Optionally retimes the voice-over (pitch-preserving atempo, off by
//    default).
// 3. Solves a video playback rate (<= 1) so every narration line STARTS
//    just before its zoom lands and then plays over the zoom's hold — the
//    voice leads each beat, and no line is pushed past its anchor by an
//    earlier line still speaking.
// 4. Rewrites caption windows to match the spoken lines.
//
// Captions-only mode (no narration.json clips) still gets the opening trim.
//
// Usage: WORK_DIR=/tmp/feature-demo/work node fit-timing.mjs [atempo]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const WORK_DIR = process.env.WORK_DIR || '/tmp/feature-demo/work';

const INTRO_SECONDS = 1.2; // what survives of the opening hold
const FIRST_LINE_AT = 0.7; // narration start after the video opens
const LINE_GAP = 0.35; // breathing room between spoken lines
const BEAT_LEAD = 0.4; // how far the voice leads its zoom
const MIN_RATE = 0.75; // never slow the recording below this

function ffprobeDuration(file) {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  return parseFloat(out.toString().trim());
}

const timelinePath = `${WORK_DIR}/timeline.json`;
const narrationPath = `${WORK_DIR}/narration.json`;
const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
const narration = existsSync(narrationPath)
  ? JSON.parse(readFileSync(narrationPath, 'utf8'))
  : { clips: [] };

// The narration model paces naturally, so no speed-up by default; pass an
// atempo argv (e.g. 1.1) to tighten a read that came back slow.
const ATEMPO = Number(process.argv[2] || '1.0');

// --- 1. Trim the dead opening (all times still in source-video seconds) ---

const firstBeat = timeline.captions[0]?.start;
const trim =
  firstBeat && firstBeat > INTRO_SECONDS + 0.5 ? firstBeat - INTRO_SECONDS : 0;

function shiftKeys(keys) {
  const out = [];
  for (const key of keys) {
    const t = key.t - trim;
    if (t < 0) {
      // keep at most one pre-zero key as the t=0 anchor
      const anchored = { ...key, t: 0 };
      if (out.length > 0 && out[out.length - 1].t === 0) {
        out[out.length - 1] = anchored;
      } else {
        out.push(anchored);
      }
    } else {
      out.push({ ...key, t: Math.round(t * 1000) / 1000 });
    }
  }
  return out;
}

if (trim > 0) {
  timeline.scaleKeys = shiftKeys(timeline.scaleKeys);
  timeline.focalKeys = shiftKeys(timeline.focalKeys);
  timeline.cursorKeys = shiftKeys(timeline.cursorKeys);
  timeline.clicks = timeline.clicks
    .filter((c) => c.t >= trim)
    .map((c) => ({ ...c, t: Math.round((c.t - trim) * 1000) / 1000 }));
  for (const cap of timeline.captions) {
    cap.start = Math.max(0, cap.start - trim);
    cap.end = Math.max(0, cap.end - trim);
    if (cap.anchor !== undefined) {
      cap.anchor = Math.max(0, cap.anchor - trim);
    }
  }
  timeline.video.startFromSeconds =
    (timeline.video.startFromSeconds ?? 0) + trim;
  timeline.durationSeconds -= trim;
}

// --- captions-only: trim is all there is to do ---

if (narration.clips.length === 0) {
  writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
  console.log(
    `fit: captions-only, trimmed ${trim.toFixed(2)}s, ` +
      `video ${timeline.durationSeconds.toFixed(2)}s`,
  );
  process.exit(0);
}

// --- 2. atempo the voice-over into pace, measure real durations ---

const durations = [];

for (let i = 0; i < narration.clips.length; i++) {
  const file = `${WORK_DIR}/${narration.clips[i].file}`;
  if (ATEMPO !== 1.0) {
    execFileSync(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', file, '-filter:a', `atempo=${ATEMPO}`, `${file}.f.mp3`],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    execFileSync('mv', [`${file}.f.mp3`, file]);
  }
  durations.push(ffprobeDuration(file));
}

// --- 3. solve the playback rate so the voice leads every beat ---

// Beat anchors are the (trimmed) caption starts in source-video seconds; the
// first line is anchored to the video open instead of its beat. A line is
// meant to START at its anchor (just before the zoom lands) and play over
// the zoom's hold; the schedule fails only when a line cannot start on time
// because an earlier line is still speaking.
//
// Solved by simulation rather than closed form: a line that waits for a
// late anchor ends later than any cumulative-duration estimate, so the only
// reliable check is to lay the schedule out at a candidate rate and look
// for a line pushed past its anchor.
// Anchor to when each zoom LANDS (capture emits it as `anchor`); the caption
// `start` begins with the glide, ~moveMs before the zoom arrives, and using
// it would start narration before the zoom even begins moving.
const beats = timeline.captions.map((c) => c.anchor ?? c.start);

function scheduleAt(candidateRate) {
  let prevEnd = 0;
  const lineStarts = [];
  let pushedPastAnchor = false;

  for (let i = 0; i < durations.length; i++) {
    // A line without a matching caption beat just runs sequentially.
    const anchor =
      i === 0
        ? FIRST_LINE_AT
        : beats[i] !== undefined
          ? beats[i] / candidateRate - BEAT_LEAD
          : prevEnd + LINE_GAP;
    const start = Math.max(i === 0 ? 0 : prevEnd + LINE_GAP, anchor);
    if (start > anchor + 0.01) {
      pushedPastAnchor = true;
    }
    lineStarts.push(Math.round(start * 100) / 100);
    prevEnd = start + durations[i];
  }

  return { lineStarts, pushedPastAnchor };
}

let rate = 1;
while (rate > MIN_RATE && scheduleAt(rate).pushedPastAnchor) {
  rate = Math.round((rate - 0.01) * 100) / 100;
}
rate = Math.max(MIN_RATE, rate);

if (rate !== 1) {
  const stretch = 1 / rate;
  for (const keys of [
    timeline.scaleKeys,
    timeline.focalKeys,
    timeline.cursorKeys,
  ]) {
    for (const key of keys) {
      key.t = Math.round(key.t * stretch * 1000) / 1000;
    }
  }
  for (const click of timeline.clicks) {
    click.t = Math.round(click.t * stretch * 1000) / 1000;
  }
  timeline.durationSeconds =
    Math.round(timeline.durationSeconds * stretch * 1000) / 1000;
}

timeline.video.playbackRate = rate;

// --- 4. schedule lines (voice leads each beat) + matching captions ---

const { lineStarts: starts } = scheduleAt(rate);

for (let i = 0; i < durations.length; i++) {
  narration.clips[i].startSeconds = starts[i];
  narration.clips[i].durationSeconds = Math.round(durations[i] * 1000) / 1000;
  if (timeline.captions[i]) {
    timeline.captions[i].start = starts[i];
    timeline.captions[i].end =
      Math.round((starts[i] + durations[i] + 0.25) * 1000) / 1000;
  }
}

writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
writeFileSync(narrationPath, JSON.stringify(narration, null, 2));

const narrationEnd = starts[starts.length - 1] + durations[durations.length - 1];

console.log(
  `fit: trimmed ${trim.toFixed(2)}s, rate ${rate}, ` +
    `video ${timeline.durationSeconds.toFixed(2)}s, ` +
    `narration ends ${narrationEnd.toFixed(2)}s`,
);
for (let i = 0; i < starts.length; i++) {
  console.log(
    `  line${i} ${starts[i].toFixed(2)}+${durations[i].toFixed(2)}` +
      `=${(starts[i] + durations[i]).toFixed(2)}`,
  );
}
