// Synthesize the demo's narrative BEFORE capture, so the narration drives
// the visuals: each line's real spoken duration paces its beat during
// recording, and no post-hoc retiming is needed.
//
// Reads the demo script's captioned beats (or LINES override), posts the
// lines to the Roomote control plane (which holds the TTS credentials — no
// provider key exists in this sandbox), writes vo/<i>.mp3 next to the
// script, and emits narration.json with each clip's measured duration.
// startSeconds is stamped later by the capture runner at the moment each
// beat actually lands.
//
// Exit codes: 0 = narration written; 3 = TTS not configured on this
// deployment (callers proceed captions-only; capture then paces beats from
// estimated speaking time instead); 1 = real failure.
//
// Usage: SCRIPT=/tmp/feature-demo/demo-script.json node build-narration.mjs
// Optional: LINES=/path/to/lines.json (array of spoken lines, one per
// captioned beat, when spoken wording should differ from captions).

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SCRIPT_PATH = process.env.SCRIPT || '/tmp/feature-demo/demo-script.json';
const OUT_DIR = dirname(SCRIPT_PATH);

// Same base-URL/token resolution as the roomote MCP server config.
const rawBaseUrl =
  process.env.ROOMOTE_PLATFORM_API_URL ||
  process.env.TRPC_URL ||
  'http://localhost:13001';
const baseUrl = rawBaseUrl.replace(/\/$/, '');
const token = process.env.ROOMOTE_CLOUD_TOKEN || process.env.AUTH_TOKEN;

if (!token) {
  console.error('No run token in the environment (ROOMOTE_CLOUD_TOKEN).');
  process.exit(1);
}

const script = JSON.parse(readFileSync(SCRIPT_PATH, 'utf8'));
const captions = (script.beats ?? [])
  .filter((beat) => beat.caption)
  .map((beat) => beat.caption);
const lines = process.env.LINES
  ? JSON.parse(readFileSync(process.env.LINES, 'utf8'))
  : captions;

if (!Array.isArray(lines) || lines.length === 0) {
  console.error('No narration lines (script has no captioned beats).');
  process.exit(1);
}

if (lines.length !== captions.length) {
  console.error(
    `LINES has ${lines.length} entries but the script has ` +
      `${captions.length} captioned beats; they must match 1:1 in order.`,
  );
  process.exit(1);
}

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

const run = async () => {
  const response = await fetch(`${baseUrl}/api/tts/narration`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ lines }),
  });

  if (response.status === 404) {
    console.error(
      'Narration TTS is not configured on this deployment; ' +
        'proceed captions-only (capture paces beats from caption text).',
    );
    process.exit(3);
  }

  if (!response.ok) {
    throw new Error(`TTS request failed with status ${response.status}`);
  }

  const { clips } = await response.json();

  if (!Array.isArray(clips) || clips.length !== lines.length) {
    throw new Error('TTS response did not include one clip per line');
  }

  mkdirSync(`${OUT_DIR}/vo`, { recursive: true });

  const manifest = [];

  for (let i = 0; i < clips.length; i++) {
    const file = `vo/${i}.mp3`;

    writeFileSync(
      `${OUT_DIR}/${file}`,
      Buffer.from(clips[i].audioBase64, 'base64'),
    );
    manifest.push({
      file,
      startSeconds: 0,
      durationSeconds:
        Math.round(ffprobeDuration(`${OUT_DIR}/${file}`) * 1000) / 1000,
    });
  }

  writeFileSync(
    `${OUT_DIR}/narration.json`,
    JSON.stringify({ clips: manifest }, null, 2),
  );

  const total = manifest.reduce((s, c) => s + c.durationSeconds, 0);
  console.log(
    `narration: ${manifest.length} clips (${total.toFixed(1)}s spoken) ` +
      `ready in ${OUT_DIR}/vo — capture will pace beats to them`,
  );
};

run().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
