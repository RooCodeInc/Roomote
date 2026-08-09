// Post-capture trim. With narration synthesized BEFORE capture, the runner
// paces every beat to its line and stamps clip starts as they land, so no
// retiming is needed here — the only remaining job is cutting the dead
// opening hold (page-load settle) so the demo starts immediately. All key,
// caption, and clip times shift together with the video's startFrom.
//
// Usage: WORK_DIR=/tmp/feature-demo/work node fit-timing.mjs

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const WORK_DIR = process.env.WORK_DIR || '/tmp/feature-demo/work';

const INTRO_SECONDS = 1.2; // what survives of the opening hold

const timelinePath = `${WORK_DIR}/timeline.json`;
const narrationPath = `${WORK_DIR}/narration.json`;
const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
const narration = existsSync(narrationPath)
  ? JSON.parse(readFileSync(narrationPath, 'utf8'))
  : null;

// The first visible action is the earlier of the first caption/line start
// and the first motion key after t=0.
const firstMotion = Math.min(
  ...timeline.captions.map((c) => c.start),
  ...timeline.scaleKeys.filter((k) => k.t > 0).map((k) => k.t),
  Number.POSITIVE_INFINITY,
);
const trim =
  Number.isFinite(firstMotion) && firstMotion > INTRO_SECONDS + 0.5
    ? firstMotion - INTRO_SECONDS
    : 0;

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
    cap.start = Math.max(0, Math.round((cap.start - trim) * 1000) / 1000);
    cap.end = Math.max(0, Math.round((cap.end - trim) * 1000) / 1000);
  }
  timeline.video.startFromSeconds =
    (timeline.video.startFromSeconds ?? 0) + trim;
  timeline.durationSeconds =
    Math.round((timeline.durationSeconds - trim) * 1000) / 1000;
  if (narration) {
    for (const clip of narration.clips) {
      clip.startSeconds = Math.max(
        0,
        Math.round((clip.startSeconds - trim) * 1000) / 1000,
      );
    }
  }
}

writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
if (narration) {
  writeFileSync(narrationPath, JSON.stringify(narration, null, 2));
}

console.log(
  `fit: trimmed ${trim.toFixed(2)}s, video ${timeline.durationSeconds.toFixed(2)}s` +
    (narration
      ? `, ${narration.clips.length} narration clips (paced at capture)`
      : ', captions-only'),
);
for (const cap of timeline.captions) {
  console.log(
    `  line "${cap.text}" ${cap.start.toFixed(2)}-${cap.end.toFixed(2)}`,
  );
}
