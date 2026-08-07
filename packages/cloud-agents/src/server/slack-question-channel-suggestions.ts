import { z } from 'zod';

import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from './non-task-provider-usage';

export type SlackPublicChannel = {
  id: string;
  name: string;
};

export const MAX_SLACK_QUESTION_CHANNEL_SUGGESTIONS = 4;

const GENERAL_CHANNEL_NAME = 'general';

const slackQuestionChannelSuggestionSchema = z
  .object({
    suggestedChannelIds: z
      .array(z.string().trim().describe('A non-empty Slack channel ID.'))
      .describe(
        `Up to ${MAX_SLACK_QUESTION_CHANNEL_SUGGESTIONS} non-empty Slack channel IDs.`,
      ),
  })
  .strict()
  .superRefine(({ suggestedChannelIds }, context) => {
    if (suggestedChannelIds.length > MAX_SLACK_QUESTION_CHANNEL_SUGGESTIONS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suggestedChannelIds'],
        message: `At most ${MAX_SLACK_QUESTION_CHANNEL_SUGGESTIONS} channel IDs are allowed.`,
      });
    }

    suggestedChannelIds.forEach((channelId, index) => {
      if (channelId.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['suggestedChannelIds', index],
          message: 'Channel IDs must be non-empty.',
        });
      }
    });
  });

const SLACK_QUESTION_CHANNEL_SUGGESTION_SYSTEM_PROMPT = `You choose Slack channels for an AI coding assistant invite.
Return only channel IDs from the provided list.
Choose up to 4 public channels where general code questions and answers would likely help teammates too.
Prefer channels whose names suggest engineering-wide discussion, developer help, technical Q&A, or broadly relevant code conversations.
Common useful patterns include names like general, eng, engineering, dev, development, help, questions, ask-*, ama-*, platform, infra, backend, frontend, mobile, web, architecture, and product-engineering.
Avoid channels that look like alerts, incidents, deploy logs, bot spam, social chat, hiring, sales, or narrowly scoped status channels unless they still look broadly useful for code questions.
If no channel seems appropriate, return an empty list.
If #general exists and nothing else is clearly better, use it as the main fallback.`;

function normalizeChannelName(name: string): string {
  return name.trim().toLowerCase();
}

function dedupeChannels(channels: SlackPublicChannel[]): SlackPublicChannel[] {
  const seen = new Set<string>();
  const deduped: SlackPublicChannel[] = [];

  for (const channel of channels) {
    if (seen.has(channel.id)) {
      continue;
    }

    seen.add(channel.id);
    deduped.push(channel);
  }

  return deduped;
}

function buildSlackQuestionChannelSuggestionPrompt(
  channels: SlackPublicChannel[],
): string {
  const channelLines = channels
    .map((channel) => `- ${channel.id} | #${channel.name}`)
    .join('\n');

  return [
    'Select up to 4 channel IDs from this public channel list.',
    'Only pick channels where teammates would plausibly benefit from seeing general coding questions and answers.',
    'Public channels:',
    channelLines,
  ].join('\n\n');
}

function selectFallbackGeneralChannel(
  channels: SlackPublicChannel[],
): SlackPublicChannel[] {
  const generalChannel = channels.find(
    (channel) => normalizeChannelName(channel.name) === GENERAL_CHANNEL_NAME,
  );

  return generalChannel ? [generalChannel] : [];
}

export async function suggestSlackQuestionChannels(params: {
  userId?: string | null;
  taskId?: string | null;
  channels: SlackPublicChannel[];
}): Promise<SlackPublicChannel[]> {
  const channels = dedupeChannels(params.channels).filter(
    (channel) => channel.id.trim().length > 0 && channel.name.trim().length > 0,
  );

  if (channels.length === 0) {
    return [];
  }

  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const generalFallback = selectFallbackGeneralChannel(channels);

  try {
    const { object } = await generateTrackedNonTaskObject({
      userId: params.userId,
      taskId: params.taskId,
      surface: NON_TASK_INFERENCE_SURFACES.slackQuestionChannelSuggestions,
      schema: slackQuestionChannelSuggestionSchema,
      system: SLACK_QUESTION_CHANNEL_SUGGESTION_SYSTEM_PROMPT,
      prompt: buildSlackQuestionChannelSuggestionPrompt(channels),
    });

    const suggestedChannels: SlackPublicChannel[] = [];
    const seen = new Set<string>();

    for (const channelId of object.suggestedChannelIds) {
      const channel = channelById.get(channelId);

      if (!channel || seen.has(channel.id)) {
        continue;
      }

      seen.add(channel.id);
      suggestedChannels.push(channel);
    }

    return suggestedChannels.length > 0 ? suggestedChannels : generalFallback;
  } catch (error) {
    console.warn(
      `[SlackQuestionChannelSuggestions] Failed to rank public Slack channels: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return generalFallback;
  }
}
