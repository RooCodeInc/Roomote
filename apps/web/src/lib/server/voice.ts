import { resolveModelProviderEnvValue } from '@roomote/db/server';

/** GPT-Live session creation. The OpenAI API key never leaves the server. */

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
const VOICE_LIVE_MODEL = 'gpt-live-1';
const LIVE_SESSION_TIMEOUT_MS = 30_000;

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

export type VoiceLiveSession = {
  sessionId: string;
  sdp: string;
};

/**
 * Exchange a browser WebRTC offer for a GPT-Live answer. Client delegation
 * keeps task reasoning, tools, model choice, and durable state in Roomote's
 * existing Fast session rather than creating a second agent in OpenAI.
 */
export async function createVoiceLiveSession(options: {
  apiKey: string;
  sdp: string;
}): Promise<VoiceLiveSession> {
  const response = await fetch(`${OPENAI_API_BASE_URL}/v1/live/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        model: VOICE_LIVE_MODEL,
        instructions: `You are the voice interface for a Roomote Fast session. Speak naturally and concisely.

Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Roomote Fast can answer questions, reason carefully, use its configured tools, and complete tasks with the model the user selected.

Delegate to the backend when:
- The user asks a question, requests an action, corrects earlier work, or needs careful reasoning.

Do not delegate to the backend when:
- The user is only greeting you or you need a brief clarification to understand the request.

Delegate before giving an answer that depends on backend work. Do not guess the result while waiting.`,
        delegation: { type: 'client' },
      },
      transport: { type: 'webrtc', sdp: options.sdp },
    }),
    signal: AbortSignal.timeout(LIVE_SESSION_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI Live session request failed with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    session?: { id?: string };
    transport?: { sdp?: string };
  };

  if (!payload.session?.id || !payload.transport?.sdp) {
    throw new Error('OpenAI Live session response was incomplete');
  }

  return { sessionId: payload.session.id, sdp: payload.transport.sdp };
}
