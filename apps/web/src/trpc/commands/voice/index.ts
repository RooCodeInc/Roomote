import { TRPCError } from '@trpc/server';

import {
  cleanVoiceTranscript,
  createVoiceLiveSession,
  resolveVoiceOpenAiKey,
  type VoiceLiveSession,
} from '@/lib/server/voice';
import { loadVoiceWorkspaceContext } from '@/lib/server/voice-context';
import type { UserAuthSuccess } from '@/types';

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
export async function createVoiceLiveSessionCommand(
  auth: UserAuthSuccess,
  input: { sdp: string },
): Promise<VoiceLiveSession> {
  const apiKey = await resolveVoiceOpenAiKey();

  if (!apiKey) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Voice is not configured for this deployment',
    });
  }

  const context = await loadVoiceWorkspaceContext(auth.userId);

  try {
    return await createVoiceLiveSession({ apiKey, sdp: input.sdp, context });
  } catch (error) {
    console.error('[voice] Failed to create GPT-Live session', error);
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: 'Failed to start a voice session',
      cause: error,
    });
  }
}

/**
 * Turn a raw speech transcript into the text that enters the Session. The
 * spoken request is never lost: when cleanup fails the raw transcript is
 * returned so the Fast session still receives it.
 */
export async function cleanVoiceTranscriptCommand(
  auth: UserAuthSuccess,
  input: { text: string },
): Promise<{ text: string }> {
  const text = input.text.trim();

  if (!(await resolveVoiceOpenAiKey())) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Voice is not configured for this deployment',
    });
  }

  const context = await loadVoiceWorkspaceContext(auth.userId);

  try {
    return {
      text: await cleanVoiceTranscript({
        userId: auth.userId,
        text,
        context,
      }),
    };
  } catch (error) {
    console.error('[voice] Failed to clean transcript, using raw text', error);
    return { text };
  }
}
