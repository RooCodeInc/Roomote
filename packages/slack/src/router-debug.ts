import {
  db,
  eq,
  getConfiguredRouterDebugSlackChannelId,
  slackInstallations,
} from '@roomote/db/server';
import type { RoutingDebugInfo } from '@roomote/cloud-agents/server';
import type { ChatPostMessageArguments } from '@slack/web-api';

import { createSlackWebClient } from './web-client';

type RouterDebugBlocks = Extract<
  ChatPostMessageArguments,
  { blocks: unknown }
>['blocks'];

export interface RouterDebugParams {
  source: string;
  sourceLink?: string;
  taskDescription: string;
  selectedWorkspace: { name: string; type: string };
  reasoning: string;
  routingDurationMs?: number;
  routingDebug?: RoutingDebugInfo;
  /** When set, this is a user correction and the value is what the user chose. */
  userRoute?: string;
}

const ROUTING_DECISION_SUBMIT_TOOL = 'submit_routing_decision';

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return trimmed.slice(0, maxLength - 3) + '...';
}

function quote(text: string): string {
  return `> ${text.replace(/\n/g, '\n> ')}`;
}

function getVisibleToolsUsed(toolsUsed: string[]): string[] {
  return [
    ...new Set(
      toolsUsed.filter(
        (toolName) =>
          Boolean(toolName) && toolName !== ROUTING_DECISION_SUBMIT_TOOL,
      ),
    ),
  ];
}

function formatToolsUsed(toolsUsed: string[]): string {
  const visibleTools = toolsUsed
    .slice(0, 5)
    .map((toolName) => `\`${truncate(toolName, 60)}\``);
  const remainingCount = toolsUsed.length - visibleTools.length;

  if (remainingCount > 0) {
    visibleTools.push(`+${remainingCount} more`);
  }

  return visibleTools.join(', ');
}

function formatModelSource(source: string): string {
  switch (source) {
    case 'preference':
      return 'user preference';
    case 'preserved':
      return 'preserved';
    case 'default':
      return 'default';
    default:
      return source;
  }
}

function formatSummaryFields(
  fields: Array<{ label: string; value: string | undefined }>,
): string {
  return fields
    .filter((field) => Boolean(field.value))
    .map((field) => `• *${field.label}:* ${field.value}`)
    .join('\n');
}

export async function postRouterDebugMessage(
  params: RouterDebugParams,
): Promise<void> {
  const debugChannelId = await getConfiguredRouterDebugSlackChannelId();

  if (!debugChannelId) {
    return;
  }

  console.log(
    `[RouterDebug] Called: channelId=${debugChannelId}, source=${params.source}`,
  );

  try {
    const installation = await db.query.slackInstallations.findFirst({
      where: eq(slackInstallations.isActive, true),
      columns: {
        botAccessToken: true,
      },
    });

    if (!installation?.botAccessToken) {
      console.warn('[RouterDebug] No active Slack installation found');
      return;
    }

    const environmentName = params.selectedWorkspace.name;
    const task = truncate(params.taskDescription, 500) || '(empty)';
    const reasoning = truncate(params.reasoning, 2500) || '(none)';

    const sourceText = params.sourceLink
      ? `<${params.sourceLink}|${params.source}>`
      : params.source;

    const environmentValue =
      params.routingDebug?.confidence != null
        ? `${environmentName} — confidence ${String(params.routingDebug.confidence)}`
        : environmentName;

    let modelValue: string | undefined;

    if (params.routingDebug?.selectedTaskModel) {
      const selectedTaskModel = params.routingDebug.selectedTaskModel;

      let routerChoiceText: string | null = null;
      if (selectedTaskModel.source !== 'preference') {
        if (selectedTaskModel.noModelChoice) {
          const noModelConfidence = selectedTaskModel.noModelChoice.confidence;
          routerChoiceText =
            noModelConfidence != null
              ? `(router choice: no model mentioned, confidence: ${String(noModelConfidence)})`
              : '(router choice: no model mentioned)';
        } else if (!selectedTaskModel.rejectedPick) {
          routerChoiceText = '(router model choice: not reported)';
        }
      }

      const modelDetails = [formatModelSource(selectedTaskModel.source)];

      if (selectedTaskModel.confidence != null) {
        modelDetails.push(`confidence ${String(selectedTaskModel.confidence)}`);
      }

      modelValue = `${selectedTaskModel.displayName} \`${selectedTaskModel.id}\` — ${modelDetails.join(', ')}`;

      if (routerChoiceText) {
        modelValue += ` ${routerChoiceText}`;
      }
    }

    const blocks: RouterDebugBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔍 *Router* | ${sourceText}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: formatSummaryFields([
            { label: 'Environment', value: environmentValue },
            {
              label: 'Environment source',
              value:
                params.routingDebug?.environmentSource === 'memory'
                  ? `memory (weight ${params.routingDebug.environmentPreferenceWeight?.toFixed(2) ?? 'unknown'})`
                  : undefined,
            },
            {
              label: 'User override',
              value: params.userRoute,
            },
            { label: 'Model', value: modelValue },
          ]),
        },
      },
    ];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Message*\n${quote(task)}`,
      },
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Why this route*\n${quote(reasoning)}`,
      },
    });

    const rejectedPick = params.routingDebug?.selectedTaskModel?.rejectedPick;

    if (rejectedPick) {
      const rejectedConfidenceText =
        rejectedPick.confidence != null
          ? String(rejectedPick.confidence)
          : 'not provided';
      const rejectedReasonText =
        rejectedPick.reason === 'not_allowed'
          ? 'not in allow-list'
          : 'below threshold';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Rejected model pick:* ${truncate(rejectedPick.displayName, 80)} \`${truncate(rejectedPick.id, 80)}\` — confidence ${rejectedConfidenceText} (${rejectedReasonText})`,
        },
      });
    }

    if (params.routingDebug?.workspaceRemapped) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '⚠️ *Environment remapped:* Suggested environment was unavailable, so the final route fell back to the resolved selection above.',
        },
      });
    }

    const visibleToolsUsed = params.routingDebug
      ? getVisibleToolsUsed(params.routingDebug.toolsUsed)
      : [];

    const footerParts: string[] = [];

    if (params.routingDurationMs != null) {
      footerParts.push(`⏱️ ${params.routingDurationMs}ms`);
    }

    if (visibleToolsUsed.length > 0) {
      footerParts.push(`🛠️ ${formatToolsUsed(visibleToolsUsed)}`);
    }

    if (footerParts.length > 0) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: footerParts.join('   •   '),
          },
        ],
      });
    }

    const client = createSlackWebClient(installation.botAccessToken);

    console.log(`[RouterDebug] Posting to channel ${debugChannelId}`);

    await client.chat.postMessage({
      channel: debugChannelId,
      text: `Router | ${params.source}`,
      unfurl_links: false,
      unfurl_media: false,
      blocks,
    });

    console.log('[RouterDebug] Posted successfully');
  } catch (error) {
    console.error(
      `[RouterDebug] Failed to post router debug message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
