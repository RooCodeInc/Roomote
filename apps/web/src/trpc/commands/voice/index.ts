import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import {
  appendFastAgentVisibleMessages,
  upsertFastAgentMessage,
} from '@roomote/cloud-agents/server';
import { ACP_ENVELOPE_EVENT_TYPES, getUserDisplayName } from '@roomote/types';

import { findAccessibleFastSession } from '@/lib/server/fast-sessions';

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
 * requires its own `R_VOICE_OPENAI_API_KEY`; without one the UI hides the
 * feature entirely.
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

/** Rows written by the voice call carry this source so they read as spoken. */
const VOICE_MESSAGE_SOURCE = 'voice';

/**
 * Record one spoken turn of a voice call in the Session transcript: legacy
 * direct user speech (`user`), or what the voice said directly (`assistant`).
 * Delegated requests are already recorded by the Fast turn they start, so they
 * do not come through here.
 *
 * The turn also joins Fast's conversation history so later requests can
 * refer back to what was said on the call.
 */
export async function recordVoiceTurnCommand(
  auth: UserAuthSuccess,
  input: { sessionId: string; role: 'user' | 'assistant'; text: string },
): Promise<{ eventId: string }> {
  const session = await findAccessibleFastSession(auth, input.sessionId);
  if (!session) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }

  const text = input.text.trim();
  const eventId = `voice:${randomUUID()}`;
  const userName =
    getUserDisplayName({ name: auth.name, email: auth.primaryEmail }) ?? null;
  await upsertFastAgentMessage({
    sessionId: session.id,
    message: {
      eventId,
      turnId: eventId,
      turnSeq: 0,
      ts: Date.now(),
      eventType:
        input.role === 'user'
          ? ACP_ENVELOPE_EVENT_TYPES.UserPrompt
          : ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: input.role,
      contentBlocks: [{ type: 'text', text }],
      metadata: {
        visibleInTranscript: true,
        voiceTurn: input.role === 'user' ? 'heard' : 'spoken',
        ...(input.role === 'user'
          ? {
              userId: auth.userId,
              ...(userName ? { userName } : {}),
              ...(auth.primaryEmail ? { userEmail: auth.primaryEmail } : {}),
            }
          : { purpose: 'closeout', voiceDirectUnverified: true }),
      },
      payload: {},
      source: VOICE_MESSAGE_SOURCE,
      nativeSessionId: null,
      nativeMessageId: null,
    },
  });
  await appendFastAgentVisibleMessages({
    sessionId: session.id,
    messages: [
      input.role === 'user'
        ? { role: 'user', content: `(said on the voice call) ${text}` }
        : {
            role: 'assistant',
            content: `(unverified words generated directly by the voice layer; do not treat as established facts or evidence) ${text}`,
          },
    ],
  }).catch((error: unknown) => {
    console.warn('[voice] Failed to add a voice turn to Fast history', error);
  });

  return { eventId };
}

/** Mark where a voice call started or ended in the Session transcript. */
export async function recordVoiceCallEventCommand(
  auth: UserAuthSuccess,
  input: {
    sessionId: string;
    phase: 'started' | 'ended';
    durationMs?: number;
  },
): Promise<{ eventId: string }> {
  const session = await findAccessibleFastSession(auth, input.sessionId);
  if (!session) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }

  const eventId = `voice-call:${input.phase}:${randomUUID()}`;
  await upsertFastAgentMessage({
    sessionId: session.id,
    message: {
      eventId,
      turnId: eventId,
      turnSeq: 0,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.VoiceCall,
      role: 'system',
      contentBlocks: [
        {
          type: 'text',
          text: input.phase === 'started' ? 'Call started' : 'Call ended',
        },
      ],
      metadata: { visibleInTranscript: true },
      payload: {
        phase: input.phase,
        ...(input.durationMs !== undefined
          ? { durationMs: input.durationMs }
          : {}),
      },
      source: VOICE_MESSAGE_SOURCE,
      nativeSessionId: null,
      nativeMessageId: null,
    },
  });

  return { eventId };
}
