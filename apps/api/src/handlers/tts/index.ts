import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../types';
import { logHandlerError } from '../utils';
import { resolveElevenLabsCredentials } from './connection';

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
 * multilingual_v2 gives voice clones a natural, conversational read at a
 * natural pace (the more "expressive" models lean announcer-voice on
 * professional clones and read too slowly).
 */
const ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2';
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

type ElevenLabsAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

async function synthesizeLine(options: {
  apiKey: string;
  voiceId: string;
  text: string;
}): Promise<{ audioBase64: string; alignment: ElevenLabsAlignment | null }> {
  // The with-timestamps variant returns character-level alignment alongside
  // the audio, which callers roll up into word timings (spoken-word caption
  // highlighting).
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      options.voiceId,
    )}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': options.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: options.text,
        model_id: ELEVENLABS_MODEL_ID,
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.75,
          style: 0.45,
        },
      }),
      signal: AbortSignal.timeout(ELEVENLABS_TTS_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(
      `ElevenLabs TTS request failed with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    audio_base64?: string;
    alignment?: ElevenLabsAlignment | null;
  };

  if (!payload.audio_base64) {
    throw new Error('ElevenLabs TTS response did not include audio');
  }

  return {
    audioBase64: payload.audio_base64,
    alignment: payload.alignment ?? null,
  };
}

export const tts = new Hono<{ Variables: Variables }>();

tts.post('/narration', async (c) => {
  let credentials;

  try {
    credentials = await resolveElevenLabsCredentials();
  } catch (error) {
    logHandlerError('ttsNarration', error);
    return c.json({ error: 'Narration synthesis failed' }, 500);
  }

  // Not configured => the feature does not exist on this deployment.
  if (!credentials) {
    return c.json({ error: 'Narration TTS is not configured' }, 404);
  }

  const { apiKey, voiceId } = credentials;

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

  const clips: {
    audioBase64: string;
    alignment: ElevenLabsAlignment | null;
  }[] = [];

  // Sequential on purpose: ElevenLabs enforces per-key concurrency limits,
  // and a narration is a handful of short lines.
  for (const text of lines) {
    try {
      clips.push(await synthesizeLine({ apiKey, voiceId, text }));
    } catch (error) {
      logHandlerError('ttsNarration', error);
      return c.json({ error: 'Narration synthesis failed' }, 502);
    }
  }

  return c.json({ clips });
});
