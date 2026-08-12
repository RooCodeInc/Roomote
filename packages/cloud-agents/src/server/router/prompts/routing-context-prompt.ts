import type { ImagePart, ModelMessage, TextPart } from 'ai';

import { ALL_REPOSITORIES, getEnabledTaskModels } from '@roomote/types';

import {
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_THREAD_MESSAGES,
  PLATFORM_WORKSPACE_VALUE,
} from '../types';
import type { RoutingContext, RoutingSource } from '../types';
import { NO_MODEL_MENTIONED_VALUE } from '../routing-resolution';

const MAX_ROUTING_IMAGE_ATTACHMENTS = 3;
const MAX_GITHUB_ROUTING_CONTEXT_CHARS = 250_000;
const GITHUB_ROUTING_BUDGET_NOTICE =
  '\n[GitHub routing context truncated to stay within routing budget]\n';
const PLATFORM_WORKSPACE_DESCRIPTION =
  'Generic Roomote platform questions about identity, capabilities, or getting started. Do not choose this for specific work, setup, or investigation requests.';

function indentMultilineText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n');
}

function buildGitHubTextBlock({
  heading,
  text,
}: {
  heading: string;
  text?: string;
}): string {
  const trimmed = text?.trim();

  if (!trimmed) {
    return '';
  }

  return `**${heading}**:\n${indentMultilineText(trimmed)}\n`;
}

function truncateGitHubSection(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }

  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= GITHUB_ROUTING_BUDGET_NOTICE.length) {
    return text.slice(0, maxChars);
  }

  return `${text.slice(0, maxChars - GITHUB_ROUTING_BUDGET_NOTICE.length)}${GITHUB_ROUTING_BUDGET_NOTICE}`;
}

function appendGitHubSection(context: string, section: string): string {
  if (!section) {
    return context;
  }

  const remainingBudget = MAX_GITHUB_ROUTING_CONTEXT_CHARS - context.length;

  if (remainingBudget <= 0) {
    return context;
  }

  return context + truncateGitHubSection(section, remainingBudget);
}

/**
 * Builds the context prompt for the LLM from the routing context.
 */
export function buildContextPrompt(
  context: RoutingContext,
  options?: {
    includePlatformWorkspace?: boolean;
  },
): string {
  let prompt = `**Task Description**:\n${truncateText(context.taskDescription, MAX_TASK_DESCRIPTION_LENGTH)}\n\n`;

  if (context.previousSuggestion) {
    const prev = context.previousSuggestion;
    const workspaceDesc =
      prev.workspaceDisplayName || prev.workspaceValue || 'previous workspace';
    prompt += `**Previous Workspace Suggestion**: ${workspaceDesc}\n`;
    prompt += '_The user is correcting the workspace suggestion._\n\n';
  }

  prompt += buildSourceContext(context.source);

  prompt += `**Workspace Selection Reminder**:
Prefer a specific environment when one is a plausible home for the work.

`;

  prompt += `\n**Available Environments**:\n`;
  for (const env of context.availableEnvironments) {
    prompt += `- ${env.name} (repositories: ${env.repositoryNames.join(', ')})${env.description ? `\n  ${env.description}` : ''}\n`;
    if (env.routingRules?.length) {
      prompt += '  Routing rules:\n';
      for (const rule of env.routingRules) {
        prompt += `  - ${rule}\n`;
      }
    }
  }
  if (context.allRepositoriesRoutingRules?.length) {
    prompt += `- ${ALL_REPOSITORIES} (all repositories)\n  Routing rules:\n`;
    for (const rule of context.allRepositoriesRoutingRules) {
      prompt += `  - ${rule}\n`;
    }
  }
  if (options?.includePlatformWorkspace !== false) {
    prompt += `- ${PLATFORM_WORKSPACE_VALUE}: ${PLATFORM_WORKSPACE_DESCRIPTION}\n`;
  }

  const enabledModels =
    context.taskModelSettings !== undefined
      ? getEnabledTaskModels(context.taskModelSettings)
      : [];

  if (enabledModels.length > 0) {
    prompt += `\n**Available Models**:\n`;
    for (const model of enabledModels) {
      prompt += `- ${model.displayName} [id: ${model.id}]\n`;
    }
    prompt += `- No model mentioned [id: ${NO_MODEL_MENTIONED_VALUE}] (choose this when the user does not name a model)\n`;
  }

  return prompt;
}

/**
 * Builds the source-specific context string for the prompt.
 */
export function buildSourceContext(source: RoutingSource): string {
  switch (source.type) {
    case 'slack': {
      let slackContext = '**Source**: Slack\n';
      if (source.channelName) {
        slackContext += `**Channel**: ${source.channelName}\n`;
      }
      if (source.images?.length) {
        const includedImageCount = Math.min(
          source.images.length,
          MAX_ROUTING_IMAGE_ATTACHMENTS,
        );
        const remainingImageCount = source.images.length - includedImageCount;
        slackContext += `**Image Attachments**: ${includedImageCount} attached`;
        if (remainingImageCount > 0) {
          slackContext += ` (${remainingImageCount} more omitted from routing input)`;
        }
        slackContext += '\n';
      }
      if (source.videoDescriptions?.length) {
        slackContext += `**Video Attachment Descriptions**:\n`;
        for (const [index, description] of source.videoDescriptions.entries()) {
          slackContext += `- Video ${index + 1}: ${description.trim()}\n`;
        }
      }
      if (source.threadMessages?.length) {
        slackContext += `**Thread Context**:\n`;
        const messages = source.threadMessages.slice(-MAX_THREAD_MESSAGES);
        for (const msg of messages) {
          slackContext += `- ${msg.user}: ${truncateText(msg.text, 200)}\n`;
        }
      }
      return slackContext + '\n';
    }

    case 'teams': {
      let teamsContext = '**Source**: Microsoft Teams\n';
      if (source.teamName) {
        teamsContext += `**Team**: ${source.teamName}\n`;
      }
      if (source.channelName) {
        teamsContext += `**Channel**: ${source.channelName}\n`;
      }
      if (source.images?.length) {
        const includedImageCount = Math.min(
          source.images.length,
          MAX_ROUTING_IMAGE_ATTACHMENTS,
        );
        const remainingImageCount = source.images.length - includedImageCount;
        teamsContext += `**Image Attachments**: ${includedImageCount} attached`;
        if (remainingImageCount > 0) {
          teamsContext += ` (${remainingImageCount} more omitted from routing input)`;
        }
        teamsContext += '\n';
      }
      if (source.threadMessages?.length) {
        teamsContext += `**Thread Context**:\n`;
        const messages = source.threadMessages.slice(-MAX_THREAD_MESSAGES);
        for (const msg of messages) {
          teamsContext += `- ${msg.user}: ${truncateText(msg.text, 200)}\n`;
        }
      }
      return teamsContext + '\n';
    }

    case 'telegram': {
      let telegramContext = '**Source**: Telegram\n';
      if (source.chatName) {
        telegramContext += `**Chat**: ${source.chatName}\n`;
      }
      if (source.images?.length) {
        const includedImageCount = Math.min(
          source.images.length,
          MAX_ROUTING_IMAGE_ATTACHMENTS,
        );
        const remainingImageCount = source.images.length - includedImageCount;
        telegramContext += `**Image Attachments**: ${includedImageCount} attached`;
        if (remainingImageCount > 0) {
          telegramContext += ` (${remainingImageCount} more omitted from routing input)`;
        }
        telegramContext += '\n';
      }
      if (source.threadMessages?.length) {
        telegramContext += `**Thread Context**:\n`;
        const messages = source.threadMessages.slice(-MAX_THREAD_MESSAGES);
        for (const msg of messages) {
          telegramContext += `- ${msg.user}: ${truncateText(msg.text, 200)}\n`;
        }
      }
      return telegramContext + '\n';
    }

    case 'discord': {
      let discordContext = '**Source**: Discord\n';
      if (source.guildName) {
        discordContext += `**Server**: ${source.guildName}\n`;
      }
      if (source.channelName) {
        discordContext += `**Channel**: ${source.channelName}\n`;
      }
      if (source.images?.length) {
        const includedImageCount = Math.min(
          source.images.length,
          MAX_ROUTING_IMAGE_ATTACHMENTS,
        );
        const remainingImageCount = source.images.length - includedImageCount;
        discordContext += `**Image Attachments**: ${includedImageCount} attached`;
        if (remainingImageCount > 0) {
          discordContext += ` (${remainingImageCount} more omitted from routing input)`;
        }
        discordContext += '\n';
      }
      if (source.threadMessages?.length) {
        discordContext += `**Thread Context**:\n`;
        const messages = source.threadMessages.slice(-MAX_THREAD_MESSAGES);
        for (const msg of messages) {
          discordContext += `- ${msg.user}: ${truncateText(msg.text, 200)}\n`;
        }
      }
      return discordContext + '\n';
    }

    case 'linear': {
      let linearContext = '**Source**: Linear\n';
      linearContext += `**Issue**: ${source.issueIdentifier} - ${source.issueTitle}\n`;
      if (source.projectName) {
        linearContext += `**Project**: ${source.projectName}\n`;
      }
      if (source.teamName) {
        linearContext += `**Team**: ${source.teamName}\n`;
      }
      if (source.guidance?.system) {
        linearContext += `**Team Guidance**: ${truncateText(source.guidance.system, 500)}\n`;
      }
      if (source.guidance?.instructions) {
        linearContext += `**Session Instructions**: ${truncateText(source.guidance.instructions, 500)}\n`;
      }
      if (source.issueDescription) {
        linearContext += `**Description**: ${truncateText(source.issueDescription, 500)}\n`;
      }
      if (source.previousComments?.length) {
        linearContext += `**Previous Comments**:\n`;
        const comments = source.previousComments.slice(-MAX_THREAD_MESSAGES);
        for (const comment of comments) {
          linearContext += `- ${comment.username ?? 'User'}: ${truncateText(comment.body, 220)}\n`;
        }
      }
      return linearContext + '\n';
    }

    case 'github': {
      let githubContext = '**Source**: GitHub\n';
      githubContext += `**Repository**: ${source.repository}\n`;
      if (source.headRefName) {
        githubContext += `**Head Branch**: ${source.headRefName}\n`;
      }
      if (source.prAuthorLogin) {
        githubContext += `**PR Author**: ${source.prAuthorLogin}\n`;
      }
      if (source.issueOrPrTitle) {
        githubContext += `**Title**: ${source.issueOrPrTitle.trim()}\n`;
      }
      githubContext = appendGitHubSection(
        githubContext,
        buildGitHubTextBlock({
          heading: 'Comment',
          text: source.commentBody,
        }),
      );
      githubContext = appendGitHubSection(
        githubContext,
        buildGitHubTextBlock({
          heading: 'Body',
          text: source.issueOrPrBody,
        }),
      );

      return appendGitHubSection(githubContext, '\n');
    }
  }
}

function parseRoutingImage(
  imageInput: string,
): { image: string; mediaType: string } | null {
  const trimmed = imageInput.trim();
  const dataUriMatch = /^data:([^;,]+);base64,(.+)$/i.exec(trimmed);

  if (dataUriMatch?.[1] && dataUriMatch[2]) {
    return {
      image: dataUriMatch[2],
      mediaType: dataUriMatch[1],
    };
  }

  if (trimmed.length >= 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return {
      image: trimmed,
      mediaType: 'image/png',
    };
  }

  return null;
}

function getRoutingImageParts(source: RoutingSource): ImagePart[] {
  if (
    (source.type !== 'slack' &&
      source.type !== 'teams' &&
      source.type !== 'telegram' &&
      source.type !== 'discord') ||
    !source.images?.length
  ) {
    return [];
  }

  return source.images
    .slice(0, MAX_ROUTING_IMAGE_ATTACHMENTS)
    .map((image) => parseRoutingImage(image))
    .filter(
      (image): image is { image: string; mediaType: string } => image !== null,
    )
    .map(
      ({ image, mediaType }): ImagePart => ({
        type: 'image',
        image,
        mediaType,
      }),
    );
}

export function buildContextMessages(
  context: RoutingContext,
  options?: {
    includePlatformWorkspace?: boolean;
  },
): ModelMessage[] {
  const content: Array<TextPart | ImagePart> = [
    {
      type: 'text',
      text: buildContextPrompt(context, options),
    },
    ...getRoutingImageParts(context.source),
  ];

  return [
    {
      role: 'user',
      content,
    },
  ];
}

/**
 * Truncates text to a maximum length, adding ellipsis if truncated.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return text.substring(0, maxLength - 3) + '...';
}
