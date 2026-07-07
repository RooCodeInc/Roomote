import type { SlackInstallation } from '@roomote/db/server';
import {
  REASONING_EFFORT_VALUES,
  isReasoningEffort,
  launchCodingHarnesses,
  resolveEvalHarnessSelection,
  type ReasoningEffort,
} from '@roomote/types';
import {
  startAutoRoutedSlackTask,
  type SlackEvent,
  type SlackNotifier,
} from '@roomote/slack';

import { processSlackAttachments } from '../helpers/attachments.js';
import { postSlackThreadMarkdownMessage } from '../helpers/thread-posting.js';
import { showManualPickerForAutoRouteFallback } from './auto-route-fallback.js';

const LEADING_EVAL_COMMAND_MENTION_PATTERN = /^\s*<@[^>]+>[\s,:;.-]*/u;
const EVAL_COMMAND_PATTERN = /^!eval(?:\s|$)/iu;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/iu;

type ParsedEvalCommand =
  | {
      ok: true;
      prompt: string;
      harness?: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      branch?: string;
      sha?: string;
    }
  | {
      ok: false;
      error: string;
    };

function stripLeadingEvalCommandMention(text: string): string {
  return text.replace(LEADING_EVAL_COMMAND_MENTION_PATTERN, '').trimStart();
}

function buildSlackEvalUsageText(): string {
  return `Use \`!eval [--branch <branch> | --sha <sha>] [--harness <${launchCodingHarnesses.join('|')}>] [--model <provider/model>] [--reasoning <${REASONING_EFFORT_VALUES.join('|')}>] <task prompt>\``;
}

export function isEvalCommandInvocation(text: string): boolean {
  return EVAL_COMMAND_PATTERN.test(stripLeadingEvalCommandMention(text));
}

export function isBareEvalCommandInvocation(text: string): boolean {
  return EVAL_COMMAND_PATTERN.test(text.trimStart());
}

export function buildSlackEvalUnavailableText(): string {
  return 'Slack eval launching is not enabled for this deployment.';
}

function parseEvalCommandText(text: string): ParsedEvalCommand {
  const mentionStrippedText = stripLeadingEvalCommandMention(text).trim();
  const match = mentionStrippedText.match(/^!eval\s*(.*)$/isu);

  if (!match) {
    return { ok: false, error: buildSlackEvalUsageText() };
  }

  const commandBody = match[1]?.trim() ?? '';
  if (!commandBody) {
    return { ok: false, error: buildSlackEvalUsageText() };
  }

  const tokens = commandBody.split(/\s+/u);
  let harness: string | undefined;
  let model: string | undefined;
  let reasoningEffort: ReasoningEffort | undefined;
  let branch: string | undefined;
  let sha: string | undefined;

  while (tokens.length > 0) {
    const option = tokens[0];

    if (!option?.startsWith('--')) {
      break;
    }

    tokens.shift();
    const value = tokens.shift();

    if (!value) {
      return { ok: false, error: buildSlackEvalUsageText() };
    }

    switch (option) {
      case '--harness':
        harness = value.trim();
        break;
      case '--model':
        model = value.trim();
        break;
      case '--reasoning': {
        const normalizedValue = value.trim();
        if (!isReasoningEffort(normalizedValue)) {
          return { ok: false, error: buildSlackEvalUsageText() };
        }
        reasoningEffort = normalizedValue;
        break;
      }
      case '--branch':
        branch = value.trim();
        break;
      case '--sha':
        if (!SHA_PATTERN.test(value.trim())) {
          return {
            ok: false,
            error:
              'The `--sha` value must be a 7 to 40 character git commit SHA.',
          };
        }
        sha = value.trim();
        break;
      default:
        return { ok: false, error: buildSlackEvalUsageText() };
    }
  }

  if (branch && sha) {
    return {
      ok: false,
      error:
        'Use either `--branch <branch>` or `--sha <sha>` for `!eval`, not both.',
    };
  }

  const harnessSelection = resolveEvalHarnessSelection({
    harness,
    model,
    reasoningEffort,
  });
  if (!harnessSelection.ok) {
    return { ok: false, error: harnessSelection.error };
  }

  const prompt = tokens.join(' ').trim();

  if (!prompt) {
    return { ok: false, error: buildSlackEvalUsageText() };
  }

  return {
    ok: true,
    prompt,
    harness,
    model,
    reasoningEffort,
    branch,
    sha,
  };
}

async function postSlackEvalCommandMessage(params: {
  slack: SlackNotifier;
  channel: string;
  threadTs: string;
  text: string;
  sourceMessageTs: string;
  userId: string;
  teamId: string;
}): Promise<void> {
  await postSlackThreadMarkdownMessage({
    slack: params.slack,
    channel: params.channel,
    threadTs: params.threadTs,
    text: params.text,
    sourceMessageTs: params.sourceMessageTs,
    conversationLog: {
      userId: params.userId,
      slackTeamId: params.teamId,
      source: 'slack_eval_command',
    },
  });
}

export async function processEvalCommandMessage(params: {
  event: SlackEvent;
  slackInstallation: Pick<
    SlackInstallation,
    'botUserId' | 'teamId' | 'teamDomain'
  >;
  slack: SlackNotifier;
  userId: string;
  teamId: string;
  ackEmoji: string;
  completionEmoji: string;
}): Promise<void> {
  const parsed = parseEvalCommandText(params.event.text);
  const threadTs = params.event.thread_ts || params.event.ts;

  if (!parsed.ok) {
    await postSlackEvalCommandMessage({
      slack: params.slack,
      channel: params.event.channel,
      threadTs,
      text: parsed.error,
      sourceMessageTs: params.event.ts,
      userId: params.userId,
      teamId: params.teamId,
    });
    return;
  }

  await params.slack.addReaction({
    channel: params.event.channel,
    timestamp: params.event.ts,
    name: params.ackEmoji,
  });

  try {
    const { images, attachmentTexts, videoDescriptions } =
      await processSlackAttachments({
        slack: params.slack,
        files: params.event.files,
        userId: params.userId,
        userTextContext: parsed.prompt,
      });

    const result = await startAutoRoutedSlackTask({
      slackInstallation: params.slackInstallation,
      slack: params.slack,
      launchUserId: params.userId,
      slackUserId: params.event.user ?? '',
      persistedSlackUserId: params.event.user ?? '',
      channel: params.event.channel,
      prompt: parsed.prompt,
      threadTs,
      originMessageTs: params.event.ts,
      processedImages: images.length > 0 ? images : undefined,
      processedImageFileIds: params.event.files?.map((file) => file.id),
      processedAttachmentFileIds: params.event.files?.map((file) => file.id),
      ...(attachmentTexts.length > 0
        ? { processedAttachmentTexts: attachmentTexts }
        : {}),
      ...(videoDescriptions.length > 0
        ? { processedVideoDescriptions: videoDescriptions }
        : {}),
      ackEmoji: params.ackEmoji,
      completionEmoji: params.completionEmoji,
      branch: parsed.branch,
      sha: parsed.sha,
      harness: parsed.harness,
      model: parsed.model,
      reasoningEffort: parsed.reasoningEffort,
    });

    if (result.status === 'started' || result.status === 'replied_inline') {
      return;
    }

    const showedManualPicker = await showManualPickerForAutoRouteFallback({
      result,
      event: params.event,
      slackInstallation: params.slackInstallation,
      userMapping: { userId: params.userId },
      slack: params.slack,
      processedImages: images.length > 0 ? images : undefined,
      processedAttachmentTexts:
        attachmentTexts.length > 0 ? attachmentTexts : undefined,
      processedVideoDescriptions:
        videoDescriptions.length > 0 ? videoDescriptions : undefined,
      processingReactionName: params.ackEmoji,
    });

    if (
      showedManualPicker ||
      (result.status === 'not_started' && result.code === 'routing_fallback')
    ) {
      return;
    }

    await postSlackEvalCommandMessage({
      slack: params.slack,
      channel: params.event.channel,
      threadTs,
      text: result.message,
      sourceMessageTs: params.event.ts,
      userId: params.userId,
      teamId: params.teamId,
    });
  } catch (error) {
    await params.slack
      .removeReaction({
        channel: params.event.channel,
        timestamp: params.event.ts,
        name: params.ackEmoji,
      })
      .catch(() => {});
    throw error;
  }
}
