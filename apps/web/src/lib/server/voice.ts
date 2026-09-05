import { resolveModelProviderEnvValue } from '@roomote/db/server';

/**
 * Live voice conversation support: server-side OpenAI access for realtime
 * transcription tokens and spoken replies. The API key stays on the control
 * plane — the browser receives only short-lived ephemeral realtime tokens
 * (for microphone transcription over WebRTC) and synthesized audio streams.
 *
 * Unset credentials mean the feature is off: status reports disabled, the
 * token mint refuses, and the TTS endpoint 404s.
 */

/**
 * A dedicated voice key wins over the deployment's general model-provider
 * key, so an operator can bill voice separately from task inference without
 * the two settings fighting (mirrors the Brain's key precedence).
 */
const VOICE_OPENAI_ENV_VAR_NAMES = [
  'R_VOICE_OPENAI_API_KEY',
  'OPENAI_API_KEY',
] as const;

const OPENAI_API_BASE_URL = 'https://api.openai.com';

/**
 * Realtime transcription model used for live microphone speech-to-text.
 * `gpt-live-transcribe` streams word-by-word deltas while the user is still
 * talking, but the API rejects `turn_detection` for it, so utterance
 * boundaries come from the browser: client-side VAD watches the microphone
 * and commits the audio buffer at each pause (see `useLiveVoice`).
 */
const VOICE_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';

const VOICE_TTS_MODEL = 'gpt-4o-mini-tts';
const VOICE_TTS_VOICE = 'marin';
/** OpenAI's TTS input cap; clients chunk longer replies. */
export const VOICE_TTS_MAX_INPUT_CHARS = 4_096;
/** PCM output: 24kHz, 16-bit signed little-endian, mono. */
export const VOICE_TTS_SAMPLE_RATE = 24_000;

const CLIENT_SECRET_TTL_SECONDS = 600;
const CLIENT_SECRET_TIMEOUT_MS = 15_000;
const VOICE_TTS_TIMEOUT_MS = 60_000;

/**
 * Spoken replies arrive one sentence at a time, so the key lookup (a
 * settings read plus decryption) is memoized briefly instead of repeated on
 * every synthesis request.
 */
const VOICE_KEY_CACHE_TTL_MS = 30_000;
let cachedVoiceKey: { value: string | undefined; expiresAt: number } | null =
  null;

export async function resolveVoiceOpenAiKey(): Promise<string | undefined> {
  const now = Date.now();

  if (cachedVoiceKey && cachedVoiceKey.expiresAt > now) {
    return cachedVoiceKey.value;
  }

  const apiKey = await resolveModelProviderEnvValue(VOICE_OPENAI_ENV_VAR_NAMES);
  const value = apiKey?.trim() || undefined;
  cachedVoiceKey = { value, expiresAt: now + VOICE_KEY_CACHE_TTL_MS };
  return value;
}

export type VoiceRealtimeClientSecret = {
  /** Ephemeral token the browser presents to OpenAI's realtime endpoint. */
  value: string;
  /** Unix seconds when the token stops working. */
  expiresAt: number;
};

/**
 * Mint an ephemeral realtime client secret scoped to a transcription-only
 * session: the browser streams microphone audio to OpenAI over WebRTC and
 * receives transcript events, but no model responses. The browser's own VAD
 * commits the buffer at each pause, which finalizes the utterance that gets
 * forwarded to the fast agent as an ordinary session reply.
 */
export async function createVoiceRealtimeClientSecret(
  apiKey: string,
): Promise<VoiceRealtimeClientSecret> {
  const response = await fetch(
    `${OPENAI_API_BASE_URL}/v1/realtime/client_secrets`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expires_after: {
          anchor: 'created_at',
          seconds: CLIENT_SECRET_TTL_SECONDS,
        },
        session: {
          type: 'transcription',
          audio: {
            input: {
              noise_reduction: { type: 'near_field' },
              transcription: { model: VOICE_TRANSCRIPTION_MODEL },
              // gpt-live-transcribe does not support server-side turn
              // detection; the client commits turns manually from its own
              // VAD, keeping the word-by-word delta stream.
              turn_detection: null,
            },
          },
        },
      }),
      signal: AbortSignal.timeout(CLIENT_SECRET_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(
      `OpenAI realtime client secret request failed with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    value?: string;
    expires_at?: number;
  };

  if (!payload.value || typeof payload.expires_at !== 'number') {
    throw new Error(
      'OpenAI realtime client secret response did not include a token',
    );
  }

  return { value: payload.value, expiresAt: payload.expires_at };
}

/**
 * Stream synthesized speech for one reply chunk. Returns the upstream PCM
 * byte stream so the route handler can pass it straight through to the
 * browser as it arrives.
 */
export async function createVoiceSpeechStream(options: {
  apiKey: string;
  text: string;
}): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`${OPENAI_API_BASE_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: VOICE_TTS_MODEL,
      voice: VOICE_TTS_VOICE,
      input: options.text,
      // PCM streams with the lowest latency (no container to buffer) and
      // feeds the browser's audio pipeline directly.
      response_format: 'pcm',
    }),
    signal: AbortSignal.timeout(VOICE_TTS_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `OpenAI speech synthesis request failed with status ${response.status}`,
    );
  }

  return response.body;
}
