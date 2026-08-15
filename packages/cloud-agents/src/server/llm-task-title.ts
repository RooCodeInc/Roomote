import { z } from 'zod';

import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from './non-task-provider-usage';

export const MAX_LLM_TASK_TITLE_WORDS = 12;
export const FALLBACK_TASK_TITLE = 'Untitled task';
/**
 * `tasks.llmTitleCheckpoint` sentinel that locks a title against every LLM
 * refresh path (enqueue-time early generation, transcript checkpoints, and
 * completion-time regeneration). Stamped at task creation for task types
 * whose titles are deterministic payload-derived strings, e.g. PR review
 * tasks titled `Review PR #<n>: <prTitle>`. Must stay above every
 * incremental checkpoint value.
 */
export const LLM_TITLE_LOCKED_CHECKPOINT = 1000;

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 800;

const generatedTaskTitleSchema = z.object({
  title: z.string(),
});

const TITLE_SYSTEM_PROMPT = `You write concise task titles for coding conversations.
Return a title only, without punctuation wrappers or commentary.
Rules:
- maximum 12 words
- write a label for the conversation; never answer the user or reply to them
- when the user asks a question, describe the question or investigation as a task; do not state an inferred answer as the title
- name the requested work; never assert an outcome or failure state such as failed, blocked, stuck, or missing unless the final message explicitly states that outcome
- base the title on the full conversation as it evolves, not just the opening or latest message
- use user messages as the primary source for the task's intention and requested outcome
- use assistant messages only to complement, clarify, or sharpen the user's intent when they add concrete context
- if assistant framing conflicts with the user, trust the user unless a later user message changes direction
- mention specific things being discussed (e.g. project names, PR numbers, features, tools, file names) rather than generic descriptions
- descriptive and specific to the user's request
- use sentence case, not title case; preserve proper nouns, acronyms, and file names, capitalize the first word
- avoid filler words
- no markdown`;

export type TaskTitleMessage = {
  role: 'user' | 'assistant';
  text: string;
};

function splitWords(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function enforceWordCap(value: string, maxWords: number): string {
  if (maxWords <= 0) {
    return '';
  }

  const words = splitWords(value);

  return words.slice(0, maxWords).join(' ');
}

export function sanitizeGeneratedTaskTitle(value: unknown): string {
  if (typeof value !== 'string') {
    return FALLBACK_TASK_TITLE;
  }

  let normalized = value
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  normalized = normalized.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim();

  if (normalized.length === 0) {
    return FALLBACK_TASK_TITLE;
  }

  return normalized;
}

export function finalizeGeneratedTaskTitle(rawTitle: unknown): string {
  const sanitized = sanitizeGeneratedTaskTitle(rawTitle);
  return enforceWordCap(sanitized, MAX_LLM_TASK_TITLE_WORDS);
}

export function isFallbackTaskTitle(value: unknown): boolean {
  return sanitizeGeneratedTaskTitle(value) === FALLBACK_TASK_TITLE;
}

function normalizeMessageText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildTaskTitlePrompt(messages: TaskTitleMessage[]): string {
  let transcript = 'Conversation transcript (speaker-labeled):\n';
  let hasMessages = false;

  for (const message of messages) {
    const messageText = normalizeMessageText(message.text).slice(
      0,
      MAX_MESSAGE_CHARS,
    );

    if (!messageText) {
      continue;
    }

    const speaker = message.role === 'user' ? '[User]' : '[Assistant]';
    const line = `${speaker} ${messageText}\n`;

    if (transcript.length + line.length > MAX_TRANSCRIPT_CHARS) {
      break;
    }

    transcript += line;
    hasMessages = true;
  }

  return hasMessages ? transcript : '';
}

export async function generateLlmTaskTitle(input: {
  userId?: string | null;
  taskId?: string | null;
  messages: TaskTitleMessage[];
}): Promise<string> {
  const prompt = buildTaskTitlePrompt(input.messages);

  if (!prompt) {
    return finalizeGeneratedTaskTitle(FALLBACK_TASK_TITLE);
  }

  const { object } = await generateTrackedNonTaskObject({
    userId: input.userId,
    taskId: input.taskId,
    surface: NON_TASK_INFERENCE_SURFACES.taskTitleGeneration,
    maxOutputTokens: 256,
    schema: generatedTaskTitleSchema,
    system: TITLE_SYSTEM_PROMPT,
    prompt,
  });

  return finalizeGeneratedTaskTitle(object?.title);
}
