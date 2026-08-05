import {
  and,
  db,
  desc,
  eq,
  getConfiguredRouterDebugDestination,
  isNotNull,
  resolveDiscordRuntimeCredentials,
  resolveTeamsBotRuntimeCredentials,
  resolveTelegramRuntimeCredentials,
  slackInstallations,
  teamsInstallations,
} from '@roomote/db/server';
import type {
  RoutingDebugInfo,
  RoutingFallbackCause,
} from '@roomote/cloud-agents/server';
import { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import { createTeamsCommunicationProviderFromEnv } from '@roomote/communication/teams-provider';
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

function formatSelectedTaskModel(
  selectedTaskModel: NonNullable<RoutingDebugInfo['selectedTaskModel']>,
): string {
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

  const modelValue = `${selectedTaskModel.displayName} \`${selectedTaskModel.id}\` — ${modelDetails.join(', ')}`;
  return routerChoiceText ? `${modelValue} ${routerChoiceText}` : modelValue;
}

function formatRejectedModelPick(
  rejectedPick: NonNullable<
    NonNullable<RoutingDebugInfo['selectedTaskModel']>['rejectedPick']
  >,
): string {
  const confidenceText =
    rejectedPick.confidence != null
      ? String(rejectedPick.confidence)
      : 'not provided';
  const reasonText =
    rejectedPick.reason === 'not_allowed'
      ? 'not in allow-list'
      : 'below threshold';

  return `${truncate(rejectedPick.displayName, 80)} \`${truncate(rejectedPick.id, 80)}\` — confidence ${confidenceText} (${reasonText})`;
}

function formatPlainRouterDebugMessage(params: RouterDebugParams): string {
  const selectedTaskModel = params.routingDebug?.selectedTaskModel;
  const rejectedPick = selectedTaskModel?.rejectedPick;
  const visibleToolsUsed = params.routingDebug
    ? getVisibleToolsUsed(params.routingDebug.toolsUsed)
    : [];
  const source = params.sourceLink
    ? `[${params.source}](${params.sourceLink})`
    : params.source;
  const environment =
    params.routingDebug?.confidence != null
      ? `${params.selectedWorkspace.name} — confidence ${String(params.routingDebug.confidence)}`
      : params.selectedWorkspace.name;
  const fields = [
    `Source: ${source}`,
    `Environment: ${environment}`,
    params.userRoute ? `User override: ${params.userRoute}` : null,
    selectedTaskModel
      ? `Model: ${formatSelectedTaskModel(selectedTaskModel)}`
      : null,
    `Message:\n${truncate(params.taskDescription, 500) || '(empty)'}`,
    `Why this route:\n${truncate(params.reasoning, 2500) || '(none)'}`,
    rejectedPick
      ? `Rejected model pick: ${formatRejectedModelPick(rejectedPick)}`
      : null,
    params.routingDebug?.workspaceRemapped
      ? 'Environment remapped: Suggested environment was unavailable, so the final route fell back to the resolved selection above.'
      : null,
    params.routingDurationMs != null
      ? `Duration: ${params.routingDurationMs}ms`
      : null,
    visibleToolsUsed.length > 0
      ? `Tools: ${formatToolsUsed(visibleToolsUsed)}`
      : null,
  ];

  return ['Router diagnostics', ...fields.filter(Boolean)].join('\n\n');
}

async function getActiveSlackBotToken(): Promise<string | null> {
  const installation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    orderBy: [desc(slackInstallations.updatedAt)],
    columns: { botAccessToken: true },
  });

  return installation?.botAccessToken ?? null;
}

async function postNonSlackRouterDebugMessage(params: {
  provider: 'discord' | 'teams' | 'telegram';
  channelId: string;
  text: string;
}): Promise<void> {
  if (params.provider === 'discord') {
    const credentials = await resolveDiscordRuntimeCredentials();
    if (!credentials.botToken) return;
    await new DiscordCommunicationProvider({
      botToken: credentials.botToken,
      ...(credentials.applicationId
        ? { applicationId: credentials.applicationId }
        : {}),
    }).postMessage({
      channelId: params.channelId,
      text: params.text,
      textFormat: 'markdown',
    });
    return;
  }

  if (params.provider === 'telegram') {
    const credentials = await resolveTelegramRuntimeCredentials();
    if (!credentials.botToken) return;
    await new TelegramCommunicationProvider({
      botToken: credentials.botToken,
    }).postMessage({
      channelId: params.channelId,
      text: params.text,
      textFormat: 'markdown',
    });
    return;
  }

  const credentials = await resolveTeamsBotRuntimeCredentials();
  const [installation] = await db
    .select({ serviceUrl: teamsInstallations.serviceUrl })
    .from(teamsInstallations)
    .where(
      and(
        eq(teamsInstallations.conversationId, params.channelId),
        eq(teamsInstallations.isActive, true),
        isNotNull(teamsInstallations.serviceUrl),
      ),
    )
    .limit(1);
  if (!installation?.serviceUrl) return;
  const provider = createTeamsCommunicationProviderFromEnv({
    ...(credentials.botAppId
      ? { R_TEAMS_BOT_APP_ID: credentials.botAppId }
      : {}),
    ...(credentials.botAppPassword
      ? { R_TEAMS_BOT_APP_PASSWORD: credentials.botAppPassword }
      : {}),
    ...(credentials.botTenantId
      ? { R_TEAMS_BOT_TENANT_ID: credentials.botTenantId }
      : {}),
    ...(credentials.botTokenEndpoint
      ? { R_TEAMS_BOT_TOKEN_ENDPOINT: credentials.botTokenEndpoint }
      : {}),
    ...(credentials.botOauthScope
      ? { R_TEAMS_BOT_OAUTH_SCOPE: credentials.botOauthScope }
      : {}),
  });
  await provider?.postMessage({
    channelId: params.channelId,
    serviceUrl: installation.serviceUrl,
    text: params.text,
    textFormat: 'markdown',
  });
}

export async function postRouterDebugText(text: string): Promise<void> {
  const destination = await getConfiguredRouterDebugDestination();
  if (!destination) return;

  try {
    if (destination.provider !== 'slack') {
      await postNonSlackRouterDebugMessage({
        provider: destination.provider,
        channelId: destination.channelId,
        text,
      });
      return;
    }

    const botAccessToken = await getActiveSlackBotToken();
    if (!botAccessToken) return;
    await createSlackWebClient(botAccessToken).chat.postMessage({
      channel: destination.channelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    console.error(
      `[RouterDebug] Failed to post router debug message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface RouterFallbackDebugParams {
  source: string;
  sourceLink?: string;
  taskDescription: string;
  /** Raw failure reason. Only posted to the internal debug destination. */
  reason: string;
  cause?: RoutingFallbackCause;
  routingDurationMs?: number;
}

function formatFallbackCause(cause: RoutingFallbackCause | undefined): string {
  return cause === 'exception'
    ? 'routing call failed (infrastructure error)'
    : 'router declined to pick a workspace';
}

/**
 * Posts a routing-fallback diagnostic to the configured router debug
 * destination. Unlike `postRouterDebugMessage`, this fires at fallback time so
 * outages are visible even when no task ends up starting.
 */
export async function postRouterFallbackDebugMessage(
  params: RouterFallbackDebugParams,
): Promise<void> {
  const destination = await getConfiguredRouterDebugDestination();

  if (!destination) {
    return;
  }

  const causeText = formatFallbackCause(params.cause);
  const task = truncate(params.taskDescription, 500) || '(empty)';
  const reason = truncate(params.reason, 2500) || '(none)';
  const durationText =
    params.routingDurationMs != null ? `${params.routingDurationMs}ms` : null;

  if (destination.provider !== 'slack') {
    const source = params.sourceLink
      ? `[${params.source}](${params.sourceLink})`
      : params.source;
    const text = [
      'Router diagnostics',
      `Source: ${source}`,
      `Routing fallback: no route was chosen, so the manual workspace picker was shown.`,
      `Cause: ${causeText}`,
      `Message:\n${task}`,
      `Failure reason:\n${reason}`,
      durationText ? `Duration: ${durationText}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      await postNonSlackRouterDebugMessage({
        provider: destination.provider,
        channelId: destination.channelId,
        text,
      });
    } catch (error) {
      console.error(
        `[RouterDebug] Failed to post router fallback debug message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }

  try {
    const botAccessToken = await getActiveSlackBotToken();

    if (!botAccessToken) {
      console.warn('[RouterDebug] No active Slack installation found');
      return;
    }

    const sourceText = params.sourceLink
      ? `<${params.sourceLink}|${params.source}>`
      : params.source;

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
          text: `*Routing fallback* — no route was chosen, so the manual workspace picker was shown.\n• *Cause:* ${causeText}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Message*\n${quote(task)}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Failure reason*\n${quote(reason)}`,
        },
      },
    ];

    if (durationText) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `⏱️ ${durationText}`,
          },
        ],
      });
    }

    await createSlackWebClient(botAccessToken).chat.postMessage({
      channel: destination.channelId,
      text: `Router fallback | ${params.source}`,
      unfurl_links: false,
      unfurl_media: false,
      blocks,
    });
  } catch (error) {
    console.error(
      `[RouterDebug] Failed to post router fallback debug message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function postRouterDebugMessage(
  params: RouterDebugParams,
): Promise<void> {
  const destination = await getConfiguredRouterDebugDestination();

  if (!destination) {
    return;
  }

  if (destination.provider !== 'slack') {
    try {
      await postNonSlackRouterDebugMessage({
        provider: destination.provider,
        channelId: destination.channelId,
        text: formatPlainRouterDebugMessage(params),
      });
    } catch (error) {
      console.error(
        `[RouterDebug] Failed to post router debug message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }

  const debugChannelId = destination.channelId;

  console.log(
    `[RouterDebug] Called: channelId=${debugChannelId}, source=${params.source}`,
  );

  try {
    const botAccessToken = await getActiveSlackBotToken();

    if (!botAccessToken) {
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

    const modelValue = params.routingDebug?.selectedTaskModel
      ? formatSelectedTaskModel(params.routingDebug.selectedTaskModel)
      : undefined;

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
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Rejected model pick:* ${formatRejectedModelPick(rejectedPick)}`,
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

    const client = createSlackWebClient(botAccessToken);

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
