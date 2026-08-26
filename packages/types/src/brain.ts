/**
 * Brain (deployment-hosted gbrain) shared contract.
 *
 * Not a catalog integration: the Brain is infrastructure, not something a
 * user connects in Settings. A deployment that supplies
 * R_BRAIN_OPENROUTER_API_KEY or R_BRAIN_OPENAI_API_KEY has a Brain;
 * everything else (client
 * provisioning, MCP delivery, ingestion) follows from that one signal. The id
 * and proxy path are shared surface; the id is reserved in
 * RESERVED_CUSTOM_MCP_SERVER_NAMES so no custom server can claim it.
 */

export const BRAIN_MCP_ID = 'gbrain';

/** API proxy mount; shared by SDK config delivery and the worker. */
export const BRAIN_PROXY_PATH = '/api/mcp/gbrain';

/**
 * Namespaces the Brain files pages under, in the order a reader should see
 * them: what the deployment is about first, then the activity streams, then
 * the pages the Brain writes about itself.
 *
 * Shared rather than local to the ingestion worker because the Settings page
 * groups a corpus by the same prefixes the collectors write, and a label that
 * drifts from the writer is a chart that quietly misattributes pages.
 */
export const BRAIN_NAMESPACES = [
  { id: 'people', prefix: 'people/', label: 'People' },
  { id: 'tasks', prefix: 'tasks/', label: 'Task memories' },
  { id: 'prs', prefix: 'prs/', label: 'Pull requests' },
  { id: 'github', prefix: 'github/', label: 'GitHub issues' },
  { id: 'slack', prefix: 'slack/', label: 'Slack' },
  { id: 'notion', prefix: 'notion/', label: 'Notion' },
  { id: 'meetings', prefix: 'meetings/', label: 'Meetings' },
  { id: 'daily', prefix: 'daily/', label: 'Daily digests' },
  { id: 'weekly', prefix: 'weekly/', label: 'Weekly syntheses' },
  { id: 'wiki', prefix: 'wiki/', label: 'Wiki' },
] as const;

export type BrainNamespaceId = (typeof BRAIN_NAMESPACES)[number]['id'];

/**
 * Bound on the missing-memory probe behind the Settings page's "ingest task
 * history" offer. At the cap the count reads as "at least this many"; shared
 * so the query that stops counting and the UI that renders the `+` agree.
 */
export const MISSING_MEMORY_EVENT_COUNT_CAP = 1_000;

/** Bucket for a slug written under a prefix this registry does not name. */
export const BRAIN_OTHER_NAMESPACE_ID = 'other';

export type BrainNamespaceBucketId =
  | BrainNamespaceId
  | typeof BRAIN_OTHER_NAMESPACE_ID;

/**
 * The slug prefix a namespace's pages are written under. Writers derive
 * their prefixes from here so a renamed prefix cannot leave the Settings
 * chart attributing pages to the catch-all bucket while ingestion carries
 * on under the old name.
 */
export function brainNamespacePrefix(id: BrainNamespaceId): string {
  return BRAIN_NAMESPACES.find((namespace) => namespace.id === id)!.prefix;
}

export function resolveBrainNamespaceId(slug: string): BrainNamespaceBucketId {
  return (
    BRAIN_NAMESPACES.find((namespace) => slug.startsWith(namespace.prefix))
      ?.id ?? BRAIN_OTHER_NAMESPACE_ID
  );
}

export function brainNamespaceLabel(id: BrainNamespaceBucketId): string {
  return (
    BRAIN_NAMESPACES.find((namespace) => namespace.id === id)?.label ?? 'Other'
  );
}

/**
 * What feeds the Brain, described once for anything that has to explain it.
 *
 * `collectorIdPrefix` is the stable half of a collector's id. The ids
 * themselves carry a version suffix that is bumped whenever page semantics
 * change (`slack-public-channels:entity-timeline-v2`) and, for collectors that
 * fan out, a partition suffix per workspace or channel. Matching on the prefix
 * means the Settings page keeps reporting a source across a version bump
 * instead of showing it as newly unknown.
 *
 * `requires` names the integration that has to be connected before the source
 * produces anything, so the UI can distinguish "nothing collected yet" from
 * "nothing to collect from".
 */
/**
 * The CURRENT versioned collector ids, in one place so the collectors that
 * write sync state and everything that reads it back (the Settings page's
 * source summaries) cannot drift. A collector's id carries a version suffix
 * that is bumped when page semantics change; a bump replays history, and the
 * readers must follow in the same commit or they keep aggregating the
 * superseded version's rows.
 */
export const BRAIN_COLLECTOR_IDS = {
  taskMemories: 'task-memory:effective-date-v2',
  pullRequestFacts: 'pull-request-facts:occurrence-date-v3',
  personIdentities: 'person-identities:members:occurrence-date-v2',
  ripplingWorkers: 'rippling-workers',
  slackPersonDirectory: 'slack-person-directory:occurrence-date-v2',
  slackPublicChannels: 'slack-public-channels:entity-timeline-v3',
  githubIssues: 'github-issues:occurrence-date-v3',
  notionPages: 'notion-pages',
  granolaMeetings: 'granola-meetings:entity-timeline-v3',
} as const;

/**
 * Page types Roomote writes into the Brain. gbrain treats `type` as an open
 * string (schema packs may add more), defaults a page without one to
 * `concept`, and its lint requires the field; these are the values that make
 * a Roomote-written page recognisable as what it is. `slack`, `meeting`,
 * `person`, and `person-alias` are gbrain's own base types.
 */
export const BRAIN_PAGE_TYPES = {
  taskMemory: 'task-memory',
  pullRequest: 'pull-request',
  githubIssue: 'github-issue',
  slackDay: 'slack',
  meeting: 'meeting',
  notionPage: 'notion-page',
  person: 'person',
  personAlias: 'person-alias',
  dailyDigest: 'daily',
  weeklySynthesis: 'weekly',
} as const;

export type BrainPageType =
  (typeof BRAIN_PAGE_TYPES)[keyof typeof BRAIN_PAGE_TYPES];

/**
 * The YAML frontmatter block for a Brain page, as a list of lines. Every
 * page carries the three fields gbrain's lint requires (`type`, `title`,
 * `created`) ahead of whatever the writer adds. `created` should be the
 * page's own stable date (the Slack day, the run's completion, the merge),
 * never the ingestion clock: collectors re-put pages idempotently, and a
 * timestamp that moves per write would turn every replay into a content
 * change. Pages without an honest date simply omit it.
 */
export function renderBrainFrontmatter(input: {
  type: BrainPageType;
  title: string;
  created?: Date | string | null;
  fields?: ReadonlyArray<string | false | null | undefined>;
}): string[] {
  const created =
    input.created instanceof Date
      ? input.created.toISOString()
      : (input.created ?? null);

  return [
    '---',
    `type: ${input.type}`,
    // JSON string syntax is valid YAML and survives colons, hashes, quotes,
    // and dashes that a bare scalar would not.
    `title: ${JSON.stringify(input.title)}`,
    ...(created ? [`created: ${created}`] : []),
    ...(input.fields ?? []).filter(
      (field): field is string => typeof field === 'string',
    ),
    '---',
  ];
}

export const BRAIN_SOURCES = [
  {
    id: 'task-memories',
    label: 'Task memories',
    description:
      'What each completed task learned: decisions, dead ends, and conventions the diff cannot show.',
    namespaceId: 'tasks',
    // Ingested through the completed-run outbox; the one-time history
    // backfill checkpoints under this collector id.
    collectorIdPrefix: 'task-memory',
    collectorIds: [BRAIN_COLLECTOR_IDS.taskMemories] as readonly string[],
    requires: null,
  },
  {
    id: 'pull-request-facts',
    label: 'Pull requests',
    description:
      'Merged pull requests as durable facts: what changed, why, and who reviewed it.',
    namespaceId: 'prs',
    collectorIdPrefix: 'pull-request-facts',
    collectorIds: [BRAIN_COLLECTOR_IDS.pullRequestFacts] as readonly string[],
    requires: null,
  },
  {
    id: 'person-identities',
    label: 'Deployment members',
    description:
      'Canonical person cards built from Roomote members and their linked provider handles. Never email addresses.',
    namespaceId: 'people',
    collectorIdPrefix: 'person-identities',
    collectorIds: [BRAIN_COLLECTOR_IDS.personIdentities] as readonly string[],
    requires: null,
  },
  {
    id: 'rippling-workers',
    label: 'Rippling workers',
    description:
      'Worker directory from Rippling, keeping role, team, and manager current on each person card.',
    namespaceId: 'people',
    collectorIdPrefix: 'rippling-workers',
    collectorIds: [BRAIN_COLLECTOR_IDS.ripplingWorkers] as readonly string[],
    requires: 'rippling',
  },
  {
    id: 'slack-person-directory',
    label: 'Slack directory',
    description:
      'Slack profiles, resolved against deployment members so one person is one entity.',
    namespaceId: 'people',
    collectorIdPrefix: 'slack-person-directory',
    collectorIds: [
      BRAIN_COLLECTOR_IDS.slackPersonDirectory,
    ] as readonly string[],
    requires: 'slack',
  },
  {
    id: 'slack-public-channels',
    label: 'Slack public channels',
    description:
      'History of the public channels the Roomote bot was added to. Private channels and DMs are never read.',
    namespaceId: 'slack',
    collectorIdPrefix: 'slack-public-channels',
    collectorIds: [
      BRAIN_COLLECTOR_IDS.slackPublicChannels,
    ] as readonly string[],
    requires: 'slack',
  },
  {
    id: 'github-issues',
    label: 'GitHub issues',
    description:
      'Bug reports, feature discussions, and decisions from the repositories Roomote can already see.',
    namespaceId: 'github',
    collectorIdPrefix: 'github-issues',
    collectorIds: [BRAIN_COLLECTOR_IDS.githubIssues] as readonly string[],
    requires: 'github',
  },
  {
    id: 'notion-pages',
    label: 'Notion',
    description:
      'Memories the connected Notion integration can reach, refreshed as they change upstream.',
    namespaceId: 'notion',
    collectorIdPrefix: 'notion-pages',
    collectorIds: [BRAIN_COLLECTOR_IDS.notionPages] as readonly string[],
    requires: 'notion',
  },
  {
    id: 'granola-meetings',
    label: 'Meeting notes',
    description:
      'Granola meeting notes and their attendees, linked to the people they mention.',
    namespaceId: 'meetings',
    collectorIdPrefix: 'granola-meetings',
    collectorIds: [BRAIN_COLLECTOR_IDS.granolaMeetings] as readonly string[],
    requires: 'granola',
  },
] as const;

export type BrainSourceId = (typeof BRAIN_SOURCES)[number]['id'];

export type BrainSourceRequirement = NonNullable<
  (typeof BRAIN_SOURCES)[number]['requires']
>;

/**
 * Map a durable sync-state row back to the source it belongs to. Partitioned
 * collectors store one row per workspace or channel under
 * `${collectorId}:${partition}`, and every collector id may carry a version
 * suffix, so only the leading segment is stable enough to match on.
 */
export function resolveBrainSourceIdForCollector(
  collectorId: string,
): BrainSourceId | null {
  const base = collectorId.split(':')[0];

  return (
    BRAIN_SOURCES.find((source) => source.collectorIdPrefix === base)?.id ??
    null
  );
}

/**
 * Map a sync-state row to its source ONLY when the row belongs to the
 * source's current collector version (the id itself or one of its
 * `:`-suffixed partitions). Rows from superseded versions, and auxiliary
 * rows sharing a source's leading segment (inventories, censuses), return
 * null: aggregating them is how a version bump quietly doubles a source's
 * stream counts.
 */
export function resolveBrainSourceIdForCurrentCollector(
  collectorId: string,
): BrainSourceId | null {
  return (
    BRAIN_SOURCES.find((source) =>
      source.collectorIds.some(
        (id) => collectorId === id || collectorId.startsWith(`${id}:`),
      ),
    )?.id ?? null
  );
}

/**
 * How many partitions a fan-out collector's deep-backfill cursor has fully
 * read, or null when the cursor does not carry that shape. Slack and GitHub
 * record their walk as `{completed: [...partitionKeys]}`; the count is the
 * honest backfill progress numerator, where counting rows with a completion
 * timestamp is not (partition rows never carry one, only the parent does,
 * and only at the end).
 */
export function parseBrainBackfillCompletedCount(
  cursor: string | null,
): number | null {
  if (!cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(cursor) as { completed?: unknown };

    return Array.isArray(parsed.completed)
      ? parsed.completed.filter((entry) => typeof entry === 'string').length
      : null;
  } catch {
    return null;
  }
}
