// Synthesize the demo's narrative BEFORE capture, so the narration drives
// the visuals: each line's real spoken duration paces its beat during
// recording, and no post-hoc retiming is needed.
//
// Reads the demo script's captioned beats — the captions ARE the spoken
// lines, verbatim — posts them to the Roomote control plane (which holds
// the TTS credentials; no provider key exists in this sandbox), writes
// vo/<i>.mp3 next to the script, and emits narration.json with each clip's
// measured duration plus per-word timings (from the provider's character
// alignment) so the renderer can highlight the word being spoken.
// startSeconds is stamped later by the capture runner at the moment each
// beat actually lands.
//
// Exit codes: 0 = narration written; 3 = TTS not configured on this
// deployment (callers proceed captions-only; capture then paces beats from
// estimated speaking time instead); 1 = real failure.
//
// Usage: SCRIPT=/tmp/feature-demo/demo-script.json node build-narration.mjs

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
// The captions are the spoken lines, verbatim — what the viewer reads is
// exactly what the voice says.
const lines = (script.beats ?? [])
  .filter((beat) => beat.caption)
  .map((beat) => beat.caption);

if (lines.length === 0) {
  console.error('No narration lines (script has no captioned beats).');
  process.exit(1);
}

// Roll the provider's character-level alignment up into word timings
// (seconds relative to clip start) for spoken-word caption highlighting.
function wordTimingsFromAlignment(text, alignment) {
  if (
    !alignment ||
    !Array.isArray(alignment.characters) ||
    !Array.isArray(alignment.character_start_times_seconds)
  ) {
    return null;
  }

  const words = [];
  let current = null;

  for (let i = 0; i < alignment.characters.length; i++) {
    const ch = alignment.characters[i];
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = null;
      }
      continue;
    }
    const start = alignment.character_start_times_seconds[i];
    const end = alignment.character_end_times_seconds?.[i] ?? start;
    if (current) {
      current.text += ch;
      current.end = end;
    } else {
      current = { text: ch, start, end };
    }
  }
  if (current) {
    words.push(current);
  }

  // Sanity: the roll-up should reproduce the spoken words in order; if the
  // provider's alignment disagrees with the text, skip highlighting rather
  // than highlight the wrong words.
  const expected = String(text).trim().split(/\s+/);
  if (words.length !== expected.length) {
    return null;
  }

  return words.map((w) => ({
    text: w.text,
    start: Math.round(w.start * 1000) / 1000,
    end: Math.round(w.end * 1000) / 1000,
  }));
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
      words: wordTimingsFromAlignment(lines[i], clips[i].alignment ?? null),
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
