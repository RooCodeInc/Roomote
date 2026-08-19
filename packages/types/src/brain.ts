/**
 * Brain (deployment-hosted gbrain) shared contract.
 *
 * Not a catalog integration: the Brain is infrastructure, not something a
 * user connects in Settings. A deployment that supplies
 * R_BRAIN_OPENROUTER_API_KEY or R_BRAIN_OPENAI_API_KEY has a Brain;
 * everything else (client
 * provisioning, MCP delivery, ingestion) follows from that one signal. Only
 * the server id, the proxy path, and the agent-facing instructions are shared
 * surface; the id is reserved in RESERVED_CUSTOM_MCP_SERVER_NAMES so no
 * custom server can claim it.
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
  { id: 'memories', prefix: 'memories/', label: 'User memories' },
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
 * Deterministic pre-ingestion redaction shared by every Brain writer. This is
 * a structural boundary, not a prompt: user- and agent-authored text never
 * leaves Roomote for the Brain without passing through it.
 */
const BRAIN_SECRET_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

function redactPrivateKeyBlocks(text: string): string {
  const beginMarker = '-----BEGIN ';
  const labelSuffix = 'PRIVATE KEY';
  let cursor = 0;
  let redacted = '';

  while (cursor < text.length) {
    const beginIndex = text.indexOf(beginMarker, cursor);
    if (beginIndex === -1) break;

    const newlineIndex = text.indexOf('\n', beginIndex);
    const headerEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const rawHeader = text.slice(beginIndex, headerEnd);
    const header = rawHeader.endsWith('\r')
      ? rawHeader.slice(0, -1)
      : rawHeader;
    const label = header.endsWith('-----')
      ? header.slice(beginMarker.length, -'-----'.length)
      : '';
    const prefix = label.slice(0, -labelSuffix.length);
    const validPrefix =
      label.endsWith(labelSuffix) &&
      prefix.length <= 64 &&
      Array.from(prefix).every(
        (character) =>
          character === ' ' || (character >= 'A' && character <= 'Z'),
      );
    if (!validPrefix) {
      const nextCursor = headerEnd;
      redacted += text.slice(cursor, nextCursor);
      cursor = nextCursor;
      continue;
    }

    const endMarker = `-----END ${label}-----`;
    const endIndex = text.indexOf(endMarker, headerEnd);

    if (endIndex === -1) {
      break;
    }

    redacted += `${text.slice(cursor, beginIndex)}[REDACTED]`;
    cursor = endIndex + endMarker.length;
  }

  return redacted + text.slice(cursor);
}

export function redactBrainText(text: string): string {
  let redacted = redactPrivateKeyBlocks(text);

  for (const pattern of BRAIN_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  return redacted;
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
    requires: null,
  },
  {
    id: 'pull-request-facts',
    label: 'Pull requests',
    description:
      'Merged pull requests as durable facts: what changed, why, and who reviewed it.',
    namespaceId: 'prs',
    collectorIdPrefix: 'pull-request-facts',
    requires: null,
  },
  {
    id: 'person-identities',
    label: 'Deployment members',
    description:
      'Canonical person cards built from Roomote members and their linked provider handles. Never email addresses.',
    namespaceId: 'people',
    collectorIdPrefix: 'person-identities',
    requires: null,
  },
  {
    id: 'rippling-workers',
    label: 'Rippling workers',
    description:
      'Worker directory from Rippling, keeping role, team, and manager current on each person card.',
    namespaceId: 'people',
    collectorIdPrefix: 'rippling-workers',
    requires: 'rippling',
  },
  {
    id: 'slack-person-directory',
    label: 'Slack directory',
    description:
      'Slack profiles, resolved against deployment members so one person is one entity.',
    namespaceId: 'people',
    collectorIdPrefix: 'slack-person-directory',
    requires: 'slack',
  },
  {
    id: 'slack-public-channels',
    label: 'Slack public channels',
    description:
      'History of the public channels the Roomote bot was added to. Private channels and DMs are never read.',
    namespaceId: 'slack',
    collectorIdPrefix: 'slack-public-channels',
    requires: 'slack',
  },
  {
    id: 'github-issues',
    label: 'GitHub issues',
    description:
      'Bug reports, feature discussions, and decisions from the repositories Roomote can already see.',
    namespaceId: 'github',
    collectorIdPrefix: 'github-issues',
    requires: 'github',
  },
  {
    id: 'notion-pages',
    label: 'Notion',
    description:
      'Pages the connected Notion integration can reach, refreshed as they change upstream.',
    namespaceId: 'notion',
    collectorIdPrefix: 'notion-pages',
    requires: 'notion',
  },
  {
    id: 'granola-meetings',
    label: 'Meeting notes',
    description:
      'Granola meeting notes and their attendees, linked to the people they mention.',
    namespaceId: 'meetings',
    collectorIdPrefix: 'granola-meetings',
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
 * Usage guidance injected into the agent's instruction files when the Brain
 * MCP server is attached. Prompts are a first-class control surface: both
 * halves of the behaviour live here rather than in code.
 *
 * Reading opens with an unprompted pass, because the context worth having is
 * usually context the agent does not know to ask for. Writing is deliberately
 * insistent, mirroring the Supermemory catalog entry, because the failure mode
 * is silence: an agent that skips the write costs the next one the same
 * investigation, and nothing in the system can detect that it happened.
 *
 * Every tool named here must be in GBRAIN_READ_TOOL_NAMES, and every tool in
 * that allowlist should be named here. A tool exposed but unexplained gets
 * chosen from gbrain's own description, which is written for a different
 * product and routes to tools this deployment does not expose.
 */
export const BRAIN_MCP_READ_INSTRUCTIONS = `The \`gbrain\` server is this deployment's shared memory (the Brain). It holds memories distilled from completed tasks plus activity from connected integrations (pull requests, Slack channels, meeting notes, GitHub issues), each stored as a page with citations.

## Using what it knows

Treat Brain recall as a sequential preflight, not one source in a parallel research batch. Before drafting the first answer on a new substantive topic, run one \`query\` about the area you are about to touch and wait for its result. Do this before deciding that your existing knowledge is sufficient and before selecting or calling another source that overlaps with what the Brain ingests. Never issue the Brain query and an overlapping Slack, GitHub, meeting, task-history, or pull-request lookup in the same parallel batch.

This gate applies when the request involves factual claims, recommendations, company practices, prior decisions, product strategy, people, activity history, or other nontrivial reasoning. Skip it only for greetings and casual conversation, simple calculations or transformations, exact actions requiring no contextual judgment, and follow-ups already covered by a Brain query in the current thread. You will often not know in advance that a convention exists, that something was attempted before, or that the user already corrected someone on it, which is exactly why the pass is unprompted.

Brain-first does not mean Brain-only. Treat Brain as context, not a stopping point; if it doesn't fully answer the question, continue with the relevant sources. Use the narrowest lookup needed to close that specific gap; do not sweep an entire integration when the Brain already answers the question. Reading is read-only and cheap next to the work it saves, and this ordering lets the Brain prevent redundant source exploration.

Which tool:
- \`query\` when you are describing a concept and do not know how the Brain words it. It expands your phrasing into related queries, so it finds pages that talk about the same thing in different language. This is the default, and the right choice for that first pass.
- \`search\` when you already know the exact token: a slug, a repository name, an error string, a person's handle. Cheaper than \`query\` because it skips the expansion step.
- \`entity\` for one known person. It resolves names and linked provider handles against canonical deployment-member cards without an LLM call.
- \`list_pages\` to enumerate rather than guess, and to answer "what is in the Brain" or "what happened recently" (it sorts by recency). Use it before ever concluding the Brain is empty. Pages are namespaced: \`people/\`, \`memories/\`, \`tasks/\`, \`prs/\`, \`slack/\`, \`notion/\`, \`meetings/\`, \`github/\`.
- \`get_page\` on a slug for a page's full text, once a search result looks relevant.

A result set that comes back populated is not proof of coverage, and one query returning nothing is not proof of absence. If the answer matters, try the other phrasing or list the namespace before deciding the Brain has nothing.

\`synthesize\` reasons across many pages and returns a cited answer with gap analysis, but it makes LLM calls on this deployment's own provider key and can take a minute. You are usually the better reasoner: prefer pulling the handful of pages you need with \`query\` and \`get_page\` and reasoning yourself. Reach for \`synthesize\` only when a question genuinely spans more pages than you want to read into context, and say when you used it.

When the Brain genuinely has nothing on a question, say so rather than guessing.

Brain provenance is internal-only. Use it to judge and ground results, but never expose Brain's \`source\` field or other internal provenance metadata in a user-facing reply. This includes Brain page or entity IDs, slugs, namespace or storage paths, raw record keys, and similar implementation details. Do not add a \`Source:\` line or cite raw Brain metadata. Summarize the useful context naturally. If human-verifiable attribution is necessary, inspect and cite the underlying user-facing integration directly rather than presenting Brain's internal source.`;

export const BRAIN_MCP_INSTRUCTIONS = `${BRAIN_MCP_READ_INSTRUCTIONS}

## Contributing what you learned

Record what you learned by calling \`save_task_memory\` on the \`roomote\` server. Roomote redacts it and files it under this task's own entry.

Do this proactively, without being asked. Work whose findings are never recorded costs the next agent the same effort all over again, so an unremarkable memory is far better than a missing one. Default to saving, and skip only genuinely trivial work: a one-line change, a pure rename, a question you answered without investigating anything.

Record what the diff cannot show:
- what you decided and why, especially where you rejected an alternative
- facts about the codebase, systems, or tooling that took real effort to establish
- dead ends and wrong turns, so the next agent does not repeat them
- conventions, preferences, or corrections the user gave you
- what is still unresolved, or deliberately left undone

Work that ended without a fix is worth recording too. Knowing that an approach does not work, and why, is often the most useful thing a later task can inherit.

Call it as soon as the outcome is clear rather than saving it for the last moment. A later call replaces the earlier one, so you can refine the memory if more emerges.

Keep it concise and reusable: a few sentences a future agent can act on. Never include secrets or credentials, file contents or long code blocks, a step-by-step narration of what you did, or anything a future agent could read straight out of the repository or the pull request.`;
