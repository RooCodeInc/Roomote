import { Hono } from 'hono';
import { Env } from '@roomote/env';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../types';
import { logHandlerError } from '../utils';

/**
 * Narration text-to-speech for task sandboxes, used by the feature-demo
 * skill. The sandbox posts plain narration lines with its run-scoped token;
 * the ElevenLabs key lives only on the control plane (`R_ELEVENLABS_API_KEY`
 * is in `CONTROL_PLANE_ENV_VAR_NAMES`, so it is also stripped from sandbox
 * env injection) and the synthesized audio streams back as base64 clips.
 *
 * Unset credentials mean the feature is off: the endpoint 404s and callers
 * degrade to captions-only output.
 */

type NarrationBody = {
  lines?: unknown;
};

class RequestBodyTooLargeError extends Error {}

function isRunTokenContext(
  auth: Variables['authContext'],
): auth is RunTokenContext {
  return Boolean(auth && 'runId' in auth);
}

/** Narration is a handful of short spoken lines, not prose. */
const MAX_NARRATION_LINES = 24;
const MAX_NARRATION_LINE_CHARS = 1_200;
const MAX_NARRATION_REQUEST_BYTES = 64 * 1024;

/**
 * v3 is the most natural read for voice clones; stability 1.0 ("robust")
 * anchors delivery to the reference audio, which prevents the accent drift
 * v3 exhibits at lower stability on instant clones.
 */
const DEFAULT_ELEVENLABS_MODEL = 'eleven_v3';
const ELEVENLABS_TTS_TIMEOUT_MS = 60_000;

async function readRequestBodyBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError();
    }

    chunks.push(value);
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bodyBytes;
}

function parseNarrationLines(body: NarrationBody): string[] | null {
  if (!Array.isArray(body.lines)) {
    return null;
  }

  if (body.lines.length === 0 || body.lines.length > MAX_NARRATION_LINES) {
    return null;
  }

  const lines: string[] = [];

  for (const line of body.lines) {
    if (typeof line !== 'string') {
      return null;
    }

    const trimmed = line.trim();

    if (!trimmed || trimmed.length > MAX_NARRATION_LINE_CHARS) {
      return null;
    }

    lines.push(trimmed);
  }

  return lines;
}

async function synthesizeLine(options: {
  apiKey: string;
  voiceId: string;
  modelId: string;
  text: string;
}): Promise<Buffer> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      options.voiceId,
    )}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': options.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: options.text,
        model_id: options.modelId,
        voice_settings: options.modelId.startsWith('eleven_v3')
          ? { stability: 1.0, similarity_boost: 0.75 }
          : { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: AbortSignal.timeout(ELEVENLABS_TTS_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(
      `ElevenLabs TTS request failed with status ${response.status}`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

export const tts = new Hono<{ Variables: Variables }>();

tts.post('/narration', async (c) => {
  const apiKey = Env.R_ELEVENLABS_API_KEY;
  const voiceId = Env.R_ELEVENLABS_VOICE_ID;

  // Not configured => the feature does not exist on this deployment.
  if (!apiKey || !voiceId) {
    return c.json({ error: 'Narration TTS is not configured' }, 404);
  }

  const auth = c.get('authContext');

  // The route policy already rejects non-run tokens; this guard keeps the
  // handler honest if the policy table ever drifts.
  if (!auth || !isRunTokenContext(auth)) {
    return c.json({ error: 'Narration TTS requires a task run token' }, 403);
  }

  let body: NarrationBody;

  try {
    const bodyBytes = await readRequestBodyBytes(
      c.req.raw,
      MAX_NARRATION_REQUEST_BYTES,
    );

    body = JSON.parse(new TextDecoder().decode(bodyBytes)) as NarrationBody;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json(
        {
          error: `Request body exceeds max size of ${MAX_NARRATION_REQUEST_BYTES} bytes`,
        },
        413,
      );
    }

    return c.json({ error: 'Invalid request body' }, 400);
  }

  const lines = parseNarrationLines(body);

  if (!lines) {
    return c.json(
      {
        error:
          `lines must be 1-${MAX_NARRATION_LINES} non-empty strings of at ` +
          `most ${MAX_NARRATION_LINE_CHARS} characters`,
      },
      400,
    );
  }

  const modelId = Env.R_ELEVENLABS_MODEL || DEFAULT_ELEVENLABS_MODEL;
  const clips: { audioBase64: string }[] = [];

  // Sequential on purpose: ElevenLabs enforces per-key concurrency limits,
  // and a narration is a handful of short lines.
  for (const text of lines) {
    try {
      const audio = await synthesizeLine({ apiKey, voiceId, modelId, text });

      clips.push({ audioBase64: audio.toString('base64') });
    } catch (error) {
      logHandlerError('ttsNarration', error);
      return c.json({ error: 'Narration synthesis failed' }, 502);
    }
  }

  // The model id lets callers adapt post-processing (e.g. v3 reads slowly
  // and benefits from a pitch-preserving speed-up; v2 paces naturally).
  return c.json({ clips, modelId });
});
