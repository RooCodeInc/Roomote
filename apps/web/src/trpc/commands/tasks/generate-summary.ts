import { unstable_cache } from 'next/cache';
import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from '@roomote/cloud-agents/server/non-task-provider-usage';
import { db, tasks, users, eq } from '@roomote/db/server';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';
import { z } from 'zod';

import type { UserAuthSuccess, TaskMessageEnvelope } from '@/types';
import { getUserDisplayName } from '@/lib/user-display-name';

import { getTaskMessageEnvelopes } from '@/lib/server';

// Maximum number of messages to include in the summary prompt.
const MAX_MESSAGES = 100;

// Maximum character count for the conversation text (approximately 50k tokens worth).
const MAX_CONVERSATION_CHARS = 200_000;

// Minimum number of messages required to generate a summary.
const MIN_MESSAGES_FOR_SUMMARY = 10;

// Minimum number of new messages before regenerating the summary.
const REGENERATION_THRESHOLD = 10;

// Cache TTL: 7 days in seconds.
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

const TASK_SUMMARY_GENERATION_FAILED = 'summary_generation_failed';

const taskSummarySchema = z.object({
  summary: z.string().trim().min(1),
});

const SUMMARY_PROMPT = `You are a thoughtful, knowledgeable technical communicator. Your task is to summarize a conversation between one or more people and an AI coding assistant.

Generate a summary that covers:
- The user's apparent motivation and goals
- Key discussions and technical decisions made
- The final result or outcome
- Any unresolved issues, disregarded considerations, or gaps in test coverage

Structure guidance:
- Use short, concise sentences. Keep each paragraph to 30 words or less. This is very important.
- Limit to 4 paragraphs total.
- The first paragraph should summarize the user's goals and motivation
- The last paragraph should summmarize the final outcome
- The middle paragraphs should cover key discussions and decisions
- Don't use headings

Formatting guidance:
- Stick to prose as much as possible
- Use \`backticks\` when referencing code entities, libraries, filenames, etc
- Use italics for things that are important with regards to outcomes, decisions or missing items
- Reserve bold for critical warnings or major highlights
- Don't use emoji

Tone guidance:
- Write in a clear, professional tone.

Content guidance:
- Don't talk about tool use and other "under-the-hood" aspects of the conversation
- Highlight important decisions made by the user or the model
- Pay particular attention to whether the conversation got to a satisfactory conclusion
- The transcript may include multiple human participants. Use the speaker labels to understand who said what and in what order.
- If multiple humans appear, reflect that accurately in the narrative when it matters, but do not explicitly call out participant counts or say things like "multiple users joined the conversation" unless that detail is necessary to explain the outcome

Context guidance:
- The task was started by {user}
- The AI coding assistant is called Roomote
- The user knows the conversation exists in the context of an AI coding assistant
- The user is consulting this summary to quickly review the highlights of a conversation, mostly one that someone else had with Roomote

Here is the conversation:
`;

const SUMMARIZABLE_EVENT_TYPES = new Set<string>([
  ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
  ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
]);

function getSummarizableMessages(
  messages: TaskMessageEnvelope[],
): TaskMessageEnvelope[] {
  return messages
    .filter((m) => m.text && m.text.trim().length > 0)
    .filter((m) => SUMMARIZABLE_EVENT_TYPES.has(m.eventType))
    .slice(-MAX_MESSAGES);
}

/**
 * Bucket the message count so the cache key only changes after a meaningful
 * number of new messages, avoiding unnecessary regeneration.
 */
function bucketMessageCount(count: number): number {
  return Math.floor(count / REGENERATION_THRESHOLD) * REGENERATION_THRESHOLD;
}

async function generateSummary(
  prompt: string,
  userId: string | null,
  taskId: string,
): Promise<string> {
  const { object } = await generateTrackedNonTaskObject({
    userId,
    taskId,
    surface: NON_TASK_INFERENCE_SURFACES.taskSummaryGeneration,
    maxOutputTokens: 1024,
    prompt,
    schema: taskSummarySchema,
  });

  return object.summary;
}

function getSummaryGenerator(input: {
  userId: string | null;
  taskId: string;
  bucketedCount: number;
}) {
  const { userId, taskId, bucketedCount } = input;

  return unstable_cache(
    (prompt: string) => generateSummary(prompt, userId, taskId),
    ['task-summary', taskId, String(bucketedCount)],
    {
      revalidate: CACHE_TTL_SECONDS,
      tags: [`task-summary:${taskId}`],
    },
  );
}

type SummaryParticipantIdentity = {
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
};

type TaskStarterIdentity = SummaryParticipantIdentity & {
  fallbackName: string | null;
};

function normalizeIdentityPart(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function getParticipantIdentityKey(
  participant: SummaryParticipantIdentity,
): string | null {
  return (
    normalizeIdentityPart(participant.userId) ??
    normalizeIdentityPart(participant.userEmail) ??
    normalizeIdentityPart(participant.userName)
  );
}

function isTaskStarter(
  participant: SummaryParticipantIdentity,
  starter: TaskStarterIdentity,
): boolean {
  const participantUserId = normalizeIdentityPart(participant.userId);
  const participantEmail = normalizeIdentityPart(participant.userEmail);
  const participantName = normalizeIdentityPart(participant.userName);
  const starterUserId = normalizeIdentityPart(starter.userId);
  const starterEmail = normalizeIdentityPart(starter.userEmail);
  const starterName =
    normalizeIdentityPart(starter.userName) ??
    normalizeIdentityPart(starter.fallbackName);

  return (
    (Boolean(starterUserId) && participantUserId === starterUserId) ||
    (Boolean(starterEmail) && participantEmail === starterEmail) ||
    (Boolean(starterName) &&
      !participantUserId &&
      !participantEmail &&
      participantName === starterName)
  );
}

function getPreferredParticipantLabel(
  participant: SummaryParticipantIdentity,
  starter: TaskStarterIdentity,
): string | null {
  if (isTaskStarter(participant, starter)) {
    return (
      normalizeIdentityPart(starter.userName) ??
      normalizeIdentityPart(starter.fallbackName) ??
      normalizeIdentityPart(starter.userEmail) ??
      'Task starter'
    );
  }

  return (
    normalizeIdentityPart(participant.userName) ??
    normalizeIdentityPart(participant.userEmail)
  );
}

function buildConversationText(
  messages: TaskMessageEnvelope[],
  starter: TaskStarterIdentity,
): string {
  let conversationText = '';
  const assignedLabels = new Map<string, string>();
  const usedLabels = new Set<string>(['Roomote']);
  let anonymousParticipantCount = 0;

  for (const message of messages) {
    const lineText = message.text?.trim();
    if (!lineText) {
      continue;
    }

    let speakerLabel = 'Roomote';

    if (message.role === 'user') {
      const identity = {
        userId: message.userId ?? null,
        userName: message.userName ?? null,
        userEmail: message.userEmail ?? null,
      };
      const identityKey = getParticipantIdentityKey(identity);
      const participantIsStarter = isTaskStarter(identity, starter);

      if (identityKey && assignedLabels.has(identityKey)) {
        speakerLabel = assignedLabels.get(identityKey)!;
      } else {
        const preferredLabel = getPreferredParticipantLabel(identity, starter);
        let resolvedLabel = preferredLabel;

        if (!resolvedLabel || usedLabels.has(resolvedLabel)) {
          const alternateLabel =
            normalizeIdentityPart(identity.userEmail) ??
            normalizeIdentityPart(identity.userName);

          if (alternateLabel && !usedLabels.has(alternateLabel)) {
            resolvedLabel = alternateLabel;
          }
        }

        if (!resolvedLabel || usedLabels.has(resolvedLabel)) {
          anonymousParticipantCount += 1;
          resolvedLabel = `Participant ${anonymousParticipantCount}`;
        }

        speakerLabel = participantIsStarter
          ? `${resolvedLabel} (task starter)`
          : resolvedLabel;

        if (identityKey) {
          assignedLabels.set(identityKey, speakerLabel);
        }
        usedLabels.add(resolvedLabel);
        usedLabels.add(speakerLabel);
      }
    }

    const line = `${speakerLabel}: ${lineText}\n\n`;

    if (conversationText.length + line.length > MAX_CONVERSATION_CHARS) {
      break;
    }

    conversationText += line;
  }

  return conversationText;
}

type TaskSummaryResult =
  | {
      success: true;
      summary: string;
      messageCount: number;
      generatedForMessageCount: number;
    }
  | {
      success: false;
      error: string;
      messageCount: number;
    };

export async function generateTaskSummaryCommand(
  auth: UserAuthSuccess,
  input: { taskId: string },
): Promise<TaskSummaryResult> {
  let messageCount = 0;

  try {
    const messages = await getTaskMessageEnvelopes({
      taskId: input.taskId,
      userId: auth.userId,
    });

    const messagesToSummarize = getSummarizableMessages(messages);
    messageCount = messagesToSummarize.length;

    if (messageCount < MIN_MESSAGES_FOR_SUMMARY) {
      return {
        success: false,
        error: 'not_enough_messages',
        messageCount,
      };
    }

    // Look up the task creator's name from the DB so the summary references
    // the person who created the task, not whoever is currently viewing it.
    const [taskRow] = await db
      .select({
        taskUserId: tasks.userId,
        userName: users.name,
        userEmail: users.email,
      })
      .from(tasks)
      .leftJoin(users, eq(tasks.userId, users.id))
      .where(eq(tasks.id, input.taskId))
      .limit(1);

    const taskStarterDisplayName = getUserDisplayName({
      name: taskRow?.userName,
      email: taskRow?.userEmail,
    });
    const creatorName =
      taskStarterDisplayName?.split(' ')?.[0] ??
      auth.name?.split(' ')?.[0] ??
      'the user';
    const promptWithUserName = SUMMARY_PROMPT.replace('{user}', creatorName);
    const conversationText = buildConversationText(messagesToSummarize, {
      userId: taskRow?.taskUserId ?? null,
      userName: taskStarterDisplayName ?? null,
      userEmail: taskRow?.userEmail ?? null,
      fallbackName:
        taskRow?.taskUserId === auth.userId ? (auth.name ?? null) : null,
    });

    const bucketedCount = bucketMessageCount(messageCount);
    const generator = getSummaryGenerator({
      userId: taskRow?.taskUserId ?? null,
      taskId: input.taskId,
      bucketedCount,
    });
    const summary = await generator(promptWithUserName + conversationText);

    return {
      success: true,
      summary,
      messageCount,
      generatedForMessageCount: bucketedCount,
    };
  } catch (error) {
    console.error('Error generating task summary:', error);
    return {
      success: false,
      error: TASK_SUMMARY_GENERATION_FAILED,
      messageCount,
    };
  }
}
