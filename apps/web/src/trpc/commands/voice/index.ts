import { TRPCError } from '@trpc/server';

import {
  createVoiceRealtimeClientSecret,
  resolveVoiceOpenAiKey,
  type VoiceRealtimeClientSecret,
} from '@/lib/server/voice';

/**
 * Whether live voice conversation is available on this deployment. Voice
 * rides an OpenAI key (`R_VOICE_OPENAI_API_KEY`, falling back to the general
 * `OPENAI_API_KEY`); without one the UI hides the feature entirely.
 */
export async function getVoiceStatusCommand(): Promise<{ enabled: boolean }> {
  return { enabled: Boolean(await resolveVoiceOpenAiKey()) };
}

/**
 * Mint a short-lived ephemeral token the browser uses to open a WebRTC
 * transcription session directly with OpenAI. The deployment's API key never
 * leaves the server; the token is scoped to transcription only and expires
 * on its own.
 */
export async function createVoiceRealtimeTokenCommand(): Promise<VoiceRealtimeClientSecret> {
  const apiKey = await resolveVoiceOpenAiKey();

  if (!apiKey) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Voice is not configured for this deployment',
    });
  }

  try {
    return await createVoiceRealtimeClientSecret(apiKey);
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: 'Failed to start a voice session',
      cause: error,
    });
  }
}
