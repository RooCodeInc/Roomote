import {
  and,
  db,
  eq,
  slackInstallations,
  trackedMessages,
  workItems,
} from '@roomote/db/server';
import type { SuggestionType } from '@roomote/db/server';
import type { McpRecommendation } from '@roomote/cloud-agents/server';
import type { SlackBlock } from '@roomote/types';

import { SlackNotifier } from './slack-notifier';

export const SETUP_MCP_RECOMMENDATION_SUGGESTION_TYPE: SuggestionType =
  'setup_mcp_recommendation';
export const SETUP_MCP_RECOMMENDATION_PARENT_TEXT =
  "I scanned your codebase and found some integrations that could make me more helpful. Here's what I'd recommend:";
export const MAX_SETUP_MCP_RECOMMENDATIONS = 8;

const CATEGORY_ORDER: McpRecommendation['category'][] = [
  'built_in_integration',
  'org_integration',
];

const CATEGORY_LABELS: Record<McpRecommendation['category'], string> = {
  built_in_integration: 'Built-in integrations',
  org_integration: 'Org integrations',
};

const SLACK_ENABLE_DESCRIPTIONS: Record<string, string> = {
  asana:
    'Roomote will be able to inspect workspaces, projects, tasks, teams, and task comments.',
  grafana:
    'Roomote will be able to inspect dashboards, alert rules, live alert state, annotations, and data sources.',
  sentry:
    'Roomote will be able to inspect Sentry issue context and run scheduled Sentry triage through MCP.',
  posthog:
    'Roomote will be able to inspect analytics, feature flags, and experiments.',
  notion:
    'Roomote will be able to read Notion pages and databases for context.',
  jira: 'Roomote will be able to inspect Jira issues, workflows, and JQL search results.',
  neon: 'Roomote will get database access to inspect schemas and query data.',
  pylon:
    'Roomote will be able to inspect customer issues, message history, and account context.',
  supabase: 'Roomote will get read-only database access and platform context.',
  supermemory:
    'Roomote will be able to save shared memories and recall context from earlier tasks.',
  betterstack:
    'Roomote will be able to inspect monitoring, incidents, and telemetry.',
  railway:
    'Roomote will be able to inspect Railway account, project, and service inventory.',
  braintrust:
    'Roomote will be able to inspect prompts, evaluations, and AI run history.',
  linear:
    'Roomote will be able to pull issue, project, and roadmap context into tasks.',
  github:
    'Roomote will be able to inspect PRs, issues, and repository context.',
  slack:
    'Your team will be able to launch and continue tasks from Slack threads.',
  vercel:
    'Roomote will be able to inspect Vercel teams, projects, deployments, logs, and domain availability.',
};

type PostedMcpRecommendationMessageRow = {
  channelId: string;
  messageTs: string;
  sourceTaskId: string;
  recommendationId: string;
  createdByUserId: string;
  title: string;
  brief: string;
  sortOrder: number;
};

function buildTrackedRecommendationKey(params: {
  sourceTaskId: string;
  recommendationId: string;
}): string {
  return `${params.sourceTaskId}:mcp:${params.recommendationId}`;
}

function buildSetupUrl(
  appBaseUrl: string,
  params: Pick<McpRecommendation, 'id'>,
): string {
  const baseUrl = new URL(appBaseUrl);
  baseUrl.search = '';

  if (params.id === 'github') {
    baseUrl.pathname = '/settings/environments';
    baseUrl.searchParams.set('highlight', 'github');
    baseUrl.hash = 'source-control';
    return baseUrl.toString();
  }

  baseUrl.pathname = '/settings/integrations';
  baseUrl.searchParams.set('highlight', params.id);

  return baseUrl.toString();
}

function getSlackEnableDescription(recommendation: McpRecommendation): string {
  return (
    SLACK_ENABLE_DESCRIPTIONS[recommendation.id] ?? recommendation.description
  );
}

function getRecommendationWhyLine(recommendation: McpRecommendation): string {
  return recommendation.rationale.trim();
}

function buildRecommendationText(params: {
  recommendation: McpRecommendation;
  appBaseUrl: string;
  includeCategoryHeading: boolean;
  targetEnvironmentId?: string | null;
}): string {
  const lines: string[] = [];

  if (params.includeCategoryHeading) {
    lines.push(`*${CATEGORY_LABELS[params.recommendation.category]}*`);
  }

  lines.push(`*${params.recommendation.name}*`);
  lines.push(getSlackEnableDescription(params.recommendation));

  const whyLine = getRecommendationWhyLine(params.recommendation);

  if (whyLine) {
    lines.push(`_${whyLine}_`);
  }

  const setupUrl = buildSetupUrl(params.appBaseUrl, {
    ...params.recommendation,
  });

  lines.push(`<${setupUrl}|Set up>`);

  return lines.join('\n');
}

export function sortMcpRecommendationsForSlack(
  recommendations: McpRecommendation[],
): McpRecommendation[] {
  const categoryRank = new Map(
    CATEGORY_ORDER.map((category, index) => [category, index]),
  );

  return recommendations
    .map((recommendation, index) => ({ recommendation, index }))
    .sort((left, right) => {
      const categoryDifference =
        (categoryRank.get(left.recommendation.category) ??
          Number.MAX_SAFE_INTEGER) -
        (categoryRank.get(right.recommendation.category) ??
          Number.MAX_SAFE_INTEGER);

      if (categoryDifference !== 0) {
        return categoryDifference;
      }

      return left.index - right.index;
    })
    .slice(0, MAX_SETUP_MCP_RECOMMENDATIONS)
    .map(({ recommendation }) => recommendation);
}

export function buildMcpRecommendationBlocks(params: {
  recommendation: McpRecommendation;
  appBaseUrl: string;
  includeCategoryHeading: boolean;
  targetEnvironmentId?: string | null;
}): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  if (params.includeCategoryHeading) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*${CATEGORY_LABELS[params.recommendation.category]}*`,
        },
      ],
    });
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*${params.recommendation.name}*`,
        getSlackEnableDescription(params.recommendation),
        getRecommendationWhyLine(params.recommendation),
      ]
        .filter(Boolean)
        .map((line, index) => (index === 2 ? `_${line}_` : line))
        .join('\n'),
    },
  });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Set up',
          emoji: false,
        },
        action_id: `setup_mcp_${params.recommendation.id}`,
        url: buildSetupUrl(params.appBaseUrl, {
          ...params.recommendation,
        }),
      },
    ],
  });

  return blocks;
}

export async function postSetupMcpRecommendationsToSlack(params: {
  sourceTaskId: string;
  slackChannel: string | null;
  createdByUserId: string | null;
  recommendations: McpRecommendation[];
  appBaseUrl: string;
  targetEnvironmentId?: string | null;
}): Promise<{
  posted: boolean;
  rootMessageTs?: string;
  trackedMessages: number;
  reason?:
    | 'missing_context'
    | 'no_supported_recommendations'
    | 'already_posted'
    | 'missing_slack_installation'
    | 'post_failed';
}> {
  const supportedRecommendations = sortMcpRecommendationsForSlack(
    params.recommendations,
  );

  if (
    !params.slackChannel ||
    !params.createdByUserId ||
    params.recommendations.length === 0
  ) {
    return {
      posted: false,
      trackedMessages: 0,
      reason: 'missing_context',
    };
  }

  if (supportedRecommendations.length === 0) {
    return {
      posted: false,
      trackedMessages: 0,
      reason: 'no_supported_recommendations',
    };
  }

  // Idempotency: if we already created mcp_recommendation work items for this
  // scan task, the cards were already posted for this task.
  const existingWorkItem = await db.query.workItems.findFirst({
    where: and(
      eq(workItems.kind, 'mcp_recommendation'),
      eq(workItems.sourceTaskId, params.sourceTaskId),
    ),
    columns: { id: true },
  });

  if (existingWorkItem) {
    return {
      posted: false,
      trackedMessages: 0,
      reason: 'already_posted',
    };
  }

  const [slackInstallation] = await db
    .select({
      botAccessToken: slackInstallations.botAccessToken,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  if (!slackInstallation) {
    return {
      posted: false,
      trackedMessages: 0,
      reason: 'missing_slack_installation',
    };
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const rootMessageTs = await slack.postMessage({
    channel: params.slackChannel,
    text: SETUP_MCP_RECOMMENDATION_PARENT_TEXT,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: SETUP_MCP_RECOMMENDATION_PARENT_TEXT,
        },
      },
    ],
  });

  if (!rootMessageTs) {
    return {
      posted: false,
      trackedMessages: 0,
      reason: 'post_failed',
    };
  }

  const insertedRows: PostedMcpRecommendationMessageRow[] = [];

  for (const [index, recommendation] of supportedRecommendations.entries()) {
    const previousRecommendation = supportedRecommendations[index - 1];
    const includeCategoryHeading =
      !previousRecommendation ||
      previousRecommendation.category !== recommendation.category;
    const text = buildRecommendationText({
      recommendation,
      appBaseUrl: params.appBaseUrl,
      includeCategoryHeading,
      targetEnvironmentId: params.targetEnvironmentId,
    });
    const messageTs = await slack.postMessage({
      channel: params.slackChannel,
      thread_ts: rootMessageTs,
      text,
      blocks: buildMcpRecommendationBlocks({
        recommendation,
        appBaseUrl: params.appBaseUrl,
        includeCategoryHeading,
        targetEnvironmentId: params.targetEnvironmentId,
      }),
    });

    if (!messageTs) {
      continue;
    }

    insertedRows.push({
      channelId: params.slackChannel,
      messageTs,
      sourceTaskId: params.sourceTaskId,
      recommendationId: recommendation.id,
      createdByUserId: params.createdByUserId,
      title: recommendation.name,
      brief: getSlackEnableDescription(recommendation),
      sortOrder: index,
    });
  }

  if (insertedRows.length === 0) {
    return {
      posted: true,
      rootMessageTs,
      trackedMessages: 0,
    };
  }

  // One mcp_recommendation work_item per posted card. This is the backing row
  // the reaction-launch CAS claims; the tracked_messages suggestion_card row
  // points at it via workItemId.
  const createdWorkItems = await db
    .insert(workItems)
    .values(
      insertedRows.map((row) => ({
        kind: 'mcp_recommendation' as const,
        sourceTaskId: row.sourceTaskId,
        title: row.title,
        brief: row.brief,
        sortOrder: row.sortOrder,
        targetEnvironmentId: params.targetEnvironmentId ?? null,
      })),
    )
    .returning({ id: workItems.id });

  await db
    .insert(trackedMessages)
    .values(
      insertedRows.map((row, index) => ({
        surface: 'slack' as const,
        kind: 'suggestion_card' as const,
        dedupeKey: `${row.channelId}:${row.messageTs}`,
        channelId: row.channelId,
        messageTs: row.messageTs,
        workItemId: createdWorkItems[index]?.id,
        createdByUserId: row.createdByUserId,
        summaryText: row.title,
        metadata: {
          suggestionType: SETUP_MCP_RECOMMENDATION_SUGGESTION_TYPE,
          suggestionKey: buildTrackedRecommendationKey({
            sourceTaskId: row.sourceTaskId,
            recommendationId: row.recommendationId,
          }),
        },
      })),
    )
    .onConflictDoNothing({
      target: [trackedMessages.kind, trackedMessages.dedupeKey],
    });

  return {
    posted: true,
    rootMessageTs,
    trackedMessages: insertedRows.length,
  };
}
