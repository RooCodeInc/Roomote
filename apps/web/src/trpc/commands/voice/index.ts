import { TRPCError } from '@trpc/server';

import {
  createVoiceLiveSession,
  resolveVoiceOpenAiKey,
  type VoiceLiveSession,
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
 * Create GPT-Live on the server so the deployment key never reaches the
 * browser. The browser supplies only its SDP offer and receives the answer.
 */
export async function createVoiceLiveSessionCommand(input: {
  sdp: string;
}): Promise<VoiceLiveSession> {
  const apiKey = await resolveVoiceOpenAiKey();

  if (!apiKey) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Voice is not configured for this deployment',
    });
  }

  try {
    return await createVoiceLiveSession({ apiKey, sdp: input.sdp });
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: 'Failed to start a voice session',
      cause: error,
    });
  }
}
