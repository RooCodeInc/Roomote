import {
  db,
  getBrainSyncState,
  listBrainCollectorItemsBefore,
} from '@roomote/db/server';
import {
  createLinearClient,
  type LinearBrainIssue,
  type LinearBrainIssuePage,
} from '@roomote/linear';
import {
  BRAIN_COLLECTOR_IDS,
  BRAIN_PAGE_TYPES,
  brainNamespacePrefix,
  renderBrainFrontmatter,
} from '@roomote/types';

import { getValidAccessToken } from './mcp/data';
import {
  findLinearDeploymentMcpConnection,
  getLinearDeploymentMetadata,
} from './mcp/linear-connections';

const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';
const ISSUE_BODY_CHAR_CAP = 8_000;
const COMMENT_BODY_CHAR_CAP = 800;
const BACKFILL_PAGE_SIZE = 50;
const RETIREMENT_BATCH_SIZE = 100;
const INITIAL_INCREMENTAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const REPLAY_OVERLAP_MS = 1_000;
const CENSUS_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const INCREMENTAL_STATE_ID = `${BRAIN_COLLECTOR_IDS.linearIssues}:incremental`;
// Keep the existing inventory across replay-version bumps so a v3 census can
// retire private pages that were tracked by the v2 collector.
const LINEAR_ISSUE_INVENTORY_ID = 'linear-issues:entity-census-v2';

export type BrainLinearPage = {
  slug: string;
  title: string;
  content: string;
};

type CollectorStateUpdate = {
  collectorId: string;
  watermark?: Date;
  cursor?: string | null;
  backfillCompletedAt?: Date | null;
};

type CollectorItemUpdate = {
  collectorId: string;
  itemId: string;
  slug: string;
  lastSeenAt: Date;
};

type CollectorPageRetirement = {
  collectorId: string;
  itemId: string;
  slug: string;
};

type IncrementalCursor = {
  after: string;
  lowerBound: string;
  upperBound: string;
};

type BackfillCursor =
  | { phase: 'issues'; after: string | null; sweepStartedAt: string }
  | { phase: 'retire'; sweepStartedAt: string };

type LinearSourceContext = {
  organizationId: string;
  organizationName: string | null;
  listIssues(input: {
    first: number;
    after?: string | null;
    orderBy?: 'createdAt' | 'updatedAt';
    createdBefore?: string | null;
    updatedAfter?: string | null;
    updatedBefore?: string | null;
  }): Promise<LinearBrainIssuePage>;
};

async function getLinearSourceContext(): Promise<LinearSourceContext | null> {
  const connection = await findLinearDeploymentMcpConnection();
  const metadata = getLinearDeploymentMetadata(connection?.authConfig);
  if (!connection || !metadata) {
    return null;
  }

  const accessToken = await getValidAccessToken(connection.id, LINEAR_MCP_URL);
  if (!accessToken) {
    return null;
  }

  const client = createLinearClient(accessToken);
  return {
    organizationId: metadata.linearOrganizationId,
    organizationName: metadata.linearOrganizationName,
    listIssues: (input) => client.listIssuesForBrain(input),
  };
}

function parseIncrementalCursor(
  value: string | null,
): IncrementalCursor | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<IncrementalCursor>;
    if (
      typeof parsed.after !== 'string' ||
      typeof parsed.lowerBound !== 'string' ||
      typeof parsed.upperBound !== 'string' ||
      Number.isNaN(new Date(parsed.lowerBound).getTime()) ||
      Number.isNaN(new Date(parsed.upperBound).getTime())
    ) {
      return null;
    }
    return parsed as IncrementalCursor;
  } catch {
    return null;
  }
}

function parseBackfillCursor(value: string | null, now: Date): BackfillCursor {
  if (value) {
    try {
      const parsed = JSON.parse(value) as {
        phase?: unknown;
        after?: unknown;
        sweepStartedAt?: unknown;
      };
      if (
        (parsed.phase === 'issues' || parsed.phase === 'retire') &&
        typeof parsed.sweepStartedAt === 'string' &&
        !Number.isNaN(new Date(parsed.sweepStartedAt).getTime())
      ) {
        return parsed.phase === 'retire'
          ? { phase: 'retire', sweepStartedAt: parsed.sweepStartedAt }
          : {
              phase: 'issues',
              after: typeof parsed.after === 'string' ? parsed.after : null,
              sweepStartedAt: parsed.sweepStartedAt,
            };
      }
    } catch {
      // Idempotent page writes make restarting a malformed census safe.
    }
  }

  return {
    phase: 'issues',
    after: null,
    sweepStartedAt: now.toISOString(),
  };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function issueEventDate(issue: LinearBrainIssue): string {
  return (issue.completedAt ?? issue.canceledAt ?? issue.createdAt).slice(
    0,
    10,
  );
}

function linearIssueSlug(organizationId: string, issueId: string): string {
  return `${brainNamespacePrefix('linear')}${organizationId.toLowerCase()}/issues/${issueId.toLowerCase()}`;
}

function linearIssueLink(
  organizationId: string,
  issue: { id: string; identifier: string; title: string },
): string {
  return `[${issue.identifier}: ${issue.title}](${linearIssueSlug(organizationId, issue.id)})`;
}

function relationshipLabel(
  type: string,
  direction: 'outbound' | 'inbound',
): string {
  if (type === 'blocks') {
    return direction === 'outbound' ? 'Blocks' : 'Blocked by';
  }
  if (type === 'duplicate') {
    return direction === 'outbound' ? 'Duplicate of' : 'Duplicated by';
  }
  if (type === 'related') {
    return 'Related issues';
  }
  return direction === 'outbound'
    ? `Related (${type})`
    : `Related by (${type})`;
}

function renderLinearMetadataLines(
  organizationId: string,
  issue: LinearBrainIssue,
): string[] {
  const lines: string[] = [];
  if (issue.startedAt) lines.push(`- **Started**: ${issue.startedAt}`);
  if (issue.estimate !== null) {
    lines.push(`- **Estimate**: ${issue.estimate}`);
  }
  if (issue.cycle) {
    lines.push(
      `- **Cycle**: ${issue.cycle.name ? `${issue.cycle.name} (#${issue.cycle.number})` : `#${issue.cycle.number}`}`,
    );
  }
  if (issue.parent) {
    lines.push(
      `- **Parent**: ${linearIssueLink(organizationId, issue.parent)}`,
    );
  }

  const relationshipGroups = new Map<
    string,
    Map<string, LinearBrainIssue['relationships'][number]['issue']>
  >();
  for (const relationship of issue.relationships) {
    const label = relationshipLabel(relationship.type, relationship.direction);
    const issues = relationshipGroups.get(label) ?? new Map();
    issues.set(relationship.issue.id, relationship.issue);
    relationshipGroups.set(label, issues);
  }
  for (const [label, relatedIssues] of [...relationshipGroups].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const links = [...relatedIssues.values()]
      .sort(
        (a, b) =>
          a.identifier.localeCompare(b.identifier) ||
          a.title.localeCompare(b.title),
      )
      .map((relatedIssue) => linearIssueLink(organizationId, relatedIssue));
    lines.push(`- **${label}**: ${links.join(', ')}`);
  }
  if (issue.relationshipsTruncated) {
    lines.push(
      '_Linear truncated the relationship list; open the source issue for the rest._',
    );
  }
  return lines;
}

export function buildLinearIssuePage(input: {
  organizationId: string;
  organizationName: string | null;
  issue: LinearBrainIssue;
}): BrainLinearPage | null {
  const { issue } = input;
  if (!issue.id || !issue.identifier || !issue.title) {
    return null;
  }

  const title = `${issue.identifier}: ${issue.title}`;
  const eventDate = issueEventDate(issue);
  const discussion = issue.comments.flatMap((comment) => {
    const body = comment.body.trim();
    return body
      ? [
          `**${comment.author ?? 'unknown'}** (${comment.createdAt}):`,
          body.slice(0, COMMENT_BODY_CHAR_CAP),
          '',
        ]
      : [];
  });
  const description = issue.description?.trim() ?? '';
  const metadataLines = renderLinearMetadataLines(input.organizationId, issue);
  const content = [
    ...renderBrainFrontmatter({
      type: BRAIN_PAGE_TYPES.linearIssue,
      title,
      created: issue.createdAt,
      fields: [
        `event_date: ${eventDate}`,
        `linear_issue_id: ${yamlString(issue.id)}`,
        `identifier: ${yamlString(issue.identifier)}`,
        `organization_id: ${yamlString(input.organizationId)}`,
        input.organizationName &&
          `organization: ${yamlString(input.organizationName)}`,
        issue.team && `team: ${yamlString(issue.team.name)}`,
        issue.project && `project: ${yamlString(issue.project.name)}`,
        issue.state && `state: ${yamlString(issue.state.name)}`,
        issue.priorityLabel && `priority: ${yamlString(issue.priorityLabel)}`,
        issue.creator && `creator: ${yamlString(issue.creator.name)}`,
        issue.assignee && `assignee: ${yamlString(issue.assignee.name)}`,
        issue.labels.length > 0 &&
          `labels: ${yamlString(issue.labels.join(', '))}`,
        issue.dueDate && `due_date: ${issue.dueDate}`,
        issue.completedAt && `completed_at: ${issue.completedAt}`,
        issue.canceledAt && `canceled_at: ${issue.canceledAt}`,
        issue.archivedAt && `archived_at: ${issue.archivedAt}`,
        `updated_at: ${issue.updatedAt}`,
        'provenance: roomote-linear-issues',
      ],
    }),
    '',
    `# ${title}`,
    '',
    ...(metadataLines.length > 0
      ? ['## Metadata', '', ...metadataLines, '']
      : []),
    ...(description ? [description.slice(0, ISSUE_BODY_CHAR_CAP), ''] : []),
    ...(discussion.length > 0 ? ['## Discussion', '', ...discussion] : []),
    issue.url,
  ].join('\n');

  return {
    slug: linearIssueSlug(input.organizationId, issue.id),
    title,
    content,
  };
}

function pagesAndItems(input: {
  source: LinearSourceContext;
  issues: LinearBrainIssue[];
  seenAt: Date;
}): { pages: BrainLinearPage[]; itemUpdates: CollectorItemUpdate[] } {
  const pages: BrainLinearPage[] = [];
  const itemUpdates: CollectorItemUpdate[] = [];

  for (const issue of input.issues) {
    const page = buildLinearIssuePage({
      organizationId: input.source.organizationId,
      organizationName: input.source.organizationName,
      issue,
    });
    if (!page) continue;

    pages.push(page);
    itemUpdates.push({
      collectorId: LINEAR_ISSUE_INVENTORY_ID,
      itemId: issue.id,
      slug: page.slug,
      lastSeenAt: input.seenAt,
    });
  }

  return { pages, itemUpdates };
}

export async function collectBrainLinearIssues(input: {
  now: Date;
  limit: number;
}): Promise<{
  pages: BrainLinearPage[];
  nextSince: null;
  stateUpdates: CollectorStateUpdate[];
  itemUpdates: CollectorItemUpdate[];
}> {
  try {
    const source = await getLinearSourceContext();
    if (!source) {
      return { pages: [], nextSince: null, stateUpdates: [], itemUpdates: [] };
    }

    const [incrementalState, backfillState] = await Promise.all([
      getBrainSyncState(db, INCREMENTAL_STATE_ID),
      getBrainSyncState(db, BRAIN_COLLECTOR_IDS.linearIssues),
    ]);
    const cursor = parseIncrementalCursor(
      incrementalState?.backfillCursor ?? null,
    );
    const lowerBound =
      cursor?.lowerBound ??
      (
        incrementalState?.watermark ??
        new Date(input.now.getTime() - INITIAL_INCREMENTAL_WINDOW_MS)
      ).toISOString();
    const upperBound =
      cursor?.upperBound ??
      new Date(input.now.getTime() - REPLAY_OVERLAP_MS).toISOString();
    const result = await source.listIssues({
      first: input.limit,
      after: cursor?.after,
      updatedAfter: lowerBound,
      updatedBefore: upperBound,
    });
    const { pages, itemUpdates } = pagesAndItems({
      source,
      issues: result.issues,
      seenAt: input.now,
    });
    const stateUpdates: CollectorStateUpdate[] = [];

    if (result.pageInfo.hasNextPage && result.pageInfo.endCursor) {
      stateUpdates.push({
        collectorId: INCREMENTAL_STATE_ID,
        cursor: JSON.stringify({
          after: result.pageInfo.endCursor,
          lowerBound,
          upperBound,
        } satisfies IncrementalCursor),
      });
    } else {
      stateUpdates.push({
        collectorId: INCREMENTAL_STATE_ID,
        watermark: new Date(upperBound),
        cursor: null,
      });
    }

    if (
      backfillState?.backfillCompletedAt &&
      input.now.getTime() - backfillState.backfillCompletedAt.getTime() >=
        CENSUS_INTERVAL_MS
    ) {
      stateUpdates.push({
        collectorId: BRAIN_COLLECTOR_IDS.linearIssues,
        cursor: null,
        backfillCompletedAt: null,
      });
    }

    return { pages, nextSince: null, stateUpdates, itemUpdates };
  } catch (error) {
    console.warn(
      `[brainLinear] issue sync failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { pages: [], nextSince: null, stateUpdates: [], itemUpdates: [] };
  }
}

export async function backfillBrainLinearIssuesStep(input: {
  cursor: string | null;
  limit: number;
  now?: Date;
}): Promise<{
  pages: BrainLinearPage[];
  nextCursor: string | null;
  done: boolean;
  itemUpdates?: CollectorItemUpdate[];
  pageRetirements?: CollectorPageRetirement[];
}> {
  try {
    const source = await getLinearSourceContext();
    if (!source) {
      return { pages: [], nextCursor: input.cursor, done: false };
    }

    const cursor = parseBackfillCursor(input.cursor, input.now ?? new Date());
    const sweepStartedAt = new Date(cursor.sweepStartedAt);

    if (cursor.phase === 'retire') {
      const stale = await listBrainCollectorItemsBefore(
        db,
        LINEAR_ISSUE_INVENTORY_ID,
        sweepStartedAt,
        Math.min(input.limit, RETIREMENT_BATCH_SIZE),
      );
      if (stale.length === 0) {
        return { pages: [], nextCursor: input.cursor, done: true };
      }

      return {
        pages: [],
        nextCursor: input.cursor,
        done: false,
        pageRetirements: stale.map((item) => ({
          collectorId: LINEAR_ISSUE_INVENTORY_ID,
          itemId: item.itemId,
          slug: item.slug,
        })),
      };
    }

    const result = await source.listIssues({
      first: Math.min(input.limit, BACKFILL_PAGE_SIZE),
      after: cursor.after,
      orderBy: 'createdAt',
      createdBefore: cursor.sweepStartedAt,
    });
    const { pages, itemUpdates } = pagesAndItems({
      source,
      issues: result.issues,
      seenAt: sweepStartedAt,
    });

    return {
      pages,
      itemUpdates,
      done: false,
      nextCursor:
        result.pageInfo.hasNextPage && result.pageInfo.endCursor
          ? JSON.stringify({
              phase: 'issues',
              after: result.pageInfo.endCursor,
              sweepStartedAt: cursor.sweepStartedAt,
            } satisfies BackfillCursor)
          : JSON.stringify({
              phase: 'retire',
              sweepStartedAt: cursor.sweepStartedAt,
            } satisfies BackfillCursor),
    };
  } catch (error) {
    console.warn(
      `[brainLinear] issue backfill failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { pages: [], nextCursor: input.cursor, done: false };
  }
}
