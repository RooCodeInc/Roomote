// Fetch narrated voice-over for the demo's caption lines from the Roomote
// control plane and write per-line mp3s plus the narration manifest the
// renderer consumes.
//
// The sandbox never sees a TTS provider key: this posts plain text to
// /api/tts/narration with the run-scoped token, and the control plane holds
// the ElevenLabs credentials (R_ELEVENLABS_API_KEY / R_ELEVENLABS_VOICE_ID).
//
// Exit codes: 0 = narration written; 3 = TTS not configured on this
// deployment (callers degrade to captions-only); 1 = real failure.
//
// Usage: WORK_DIR=/tmp/feature-demo/work node build-narration.mjs
// Optional: LINES=/path/to/lines.json (array of spoken lines, one per
// caption, when the spoken wording should differ from on-screen captions).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const WORK_DIR = process.env.WORK_DIR || '/tmp/feature-demo/work';

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

const timeline = JSON.parse(
  readFileSync(`${WORK_DIR}/timeline.json`, 'utf8'),
);
const lines = process.env.LINES
  ? JSON.parse(readFileSync(process.env.LINES, 'utf8'))
  : timeline.captions.map((c) => c.text);

if (!Array.isArray(lines) || lines.length === 0) {
  console.error('No narration lines (timeline has no captions?).');
  process.exit(1);
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
        'produce a captions-only demo.',
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

  mkdirSync(`${WORK_DIR}/vo`, { recursive: true });

  const manifest = [];

  for (let i = 0; i < clips.length; i++) {
    const file = `vo/${i}.mp3`;

    writeFileSync(
      `${WORK_DIR}/${file}`,
      Buffer.from(clips[i].audioBase64, 'base64'),
    );
    // startSeconds/durationSeconds are placeholders here; fit-timing.mjs
    // measures the real durations and lays the clips out against the beats.
    manifest.push({ file, startSeconds: 0, durationSeconds: 0 });
  }

  writeFileSync(
    `${WORK_DIR}/narration.json`,
    JSON.stringify({ clips: manifest }, null, 2),
  );
  console.log(`narration: wrote ${manifest.length} clips to ${WORK_DIR}/vo`);
};

run().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
