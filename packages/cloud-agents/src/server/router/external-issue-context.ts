import type { ModelMessage } from 'ai';

import { callRouterMcpTool } from './mcp-tool-call';
import {
  matchExternalIssueUrl,
  type ExternalIssueFetchAttempt,
} from './external-issue-providers';
import type { RoutingContext } from './types';

const MAX_EXTERNAL_ISSUES = 2;
const MAX_EXTERNAL_CONTEXT_CHARS = 8_000;
const EXTERNAL_LOOKUP_TIMEOUT_MS = 8_000;
const MAX_BARE_REFERENCE_REPOS = 3;

interface ExternalIssueReference {
  url: string;
  fetchAttempts: readonly ExternalIssueFetchAttempt[];
}

function trimTrailingUrlPunctuation(value: string): string {
  let end = value.length;

  while (end > 0 && '.,;:!?'.includes(value[end - 1]!)) {
    end -= 1;
  }

  return value.slice(0, end);
}

function parseExternalIssueReferences(text: string): ExternalIssueReference[] {
  const references: ExternalIssueReference[] = [];
  const urls = text.match(/https?:\/\/[^\s<>'"\])}]+/gi) ?? [];

  for (const rawUrl of urls) {
    if (references.length >= MAX_EXTERNAL_ISSUES) {
      break;
    }

    const url = trimTrailingUrlPunctuation(rawUrl);

    try {
      const match = matchExternalIssueUrl(new URL(url));

      if (match) {
        references.push({ url, fetchAttempts: match.fetchAttempts });
      }
    } catch {
      // Ignore malformed links; routing can still proceed from the task text.
    }
  }

  return references;
}

function referenceFromCanonicalUrl(
  label: string,
  canonicalUrl: string,
): ExternalIssueReference | null {
  try {
    const match = matchExternalIssueUrl(new URL(canonicalUrl));

    return match ? { url: label, fetchAttempts: match.fetchAttempts } : null;
  } catch {
    return null;
  }
}

function uniqueConfiguredRepositories(context: RoutingContext): string[] {
  const repositories = new Set<string>();

  for (const environment of context.availableEnvironments) {
    for (const name of environment.repositoryNames ?? []) {
      repositories.add(name);
    }
  }

  return [...repositories];
}

/**
 * Resolves a bare reference the routing precheck extracted (for example
 * "#234", "acme/web#234", or "ENG-512") against the deployment's own
 * configuration. The model only proposes the reference text; the fetch
 * targets always come from this closed candidate set, so a steered or
 * hallucinated reference can at most read issues the deployment already
 * routes for. An ambiguous issue number fans out across configured
 * repositories only when that set is small enough to stay bounded.
 */
function resolveBareIssueReferences(
  context: RoutingContext,
  externalReference: string | null | undefined,
): ExternalIssueReference[] {
  const raw = externalReference?.trim();

  if (!raw) {
    return [];
  }

  if (/^[A-Za-z]+-\d+$/.test(raw)) {
    const reference = referenceFromCanonicalUrl(
      raw,
      `https://linear.app/_/issue/${raw}`,
    );

    return reference ? [reference] : [];
  }

  const configuredRepositories = uniqueConfiguredRepositories(context);
  const githubReference = (fullRepository: string, issueNumber: string) =>
    referenceFromCanonicalUrl(
      `${fullRepository}#${issueNumber}`,
      `https://github.com/${fullRepository}/issues/${issueNumber}`,
    );

  const qualified = raw.match(
    /^(?<owner>[^\s/#]+)\/(?<repository>[^\s/#]+)#(?<issueNumber>\d+)$/,
  );

  if (qualified?.groups) {
    const fullRepository = configuredRepositories.find(
      (name) =>
        name.toLowerCase() ===
        `${qualified.groups!.owner}/${qualified.groups!.repository}`.toLowerCase(),
    );
    const reference =
      fullRepository &&
      githubReference(fullRepository, qualified.groups.issueNumber!);

    return reference ? [reference] : [];
  }

  const bareNumber = raw.match(/^#?(?<issueNumber>\d+)$/);

  if (
    bareNumber?.groups &&
    configuredRepositories.length > 0 &&
    configuredRepositories.length <= MAX_BARE_REFERENCE_REPOS
  ) {
    return configuredRepositories.flatMap((fullRepository) => {
      const reference = githubReference(
        fullRepository,
        bareNumber.groups!.issueNumber!,
      );

      return reference ? [reference] : [];
    });
  }

  return [];
}

function serializeExternalContext(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function withExternalLookupTimeout<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T | null> {
  // Checked before invoking so an exhausted deadline never dispatches
  // another MCP call whose result nothing will await.
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return null;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(resolve, remainingMs, null);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function fetchExternalIssueContext(
  context: RoutingContext,
  reference: ExternalIssueReference,
): Promise<{ toolName: string; result: unknown } | null> {
  try {
    const deadline = Date.now() + EXTERNAL_LOOKUP_TIMEOUT_MS;

    for (const attempt of reference.fetchAttempts) {
      const result = await withExternalLookupTimeout(
        () =>
          callRouterMcpTool({
            context,
            serverId: attempt.serverId,
            toolName: attempt.toolName,
            args: attempt.args,
          }),
        deadline,
      );

      if (result !== null) {
        return { toolName: `${attempt.serverId}.${attempt.toolName}`, result };
      }
    }

    return null;
  } catch {
    // A disconnected integration or inaccessible issue must not block routing.
    return null;
  }
}

export async function gatherExternalIssueContext(
  context: RoutingContext,
  externalReference?: string | null,
): Promise<{ contextMessages: ModelMessage[]; toolsUsed: string[] }> {
  const urlReferences = parseExternalIssueReferences(context.taskDescription);
  const references =
    urlReferences.length > 0
      ? urlReferences
      : resolveBareIssueReferences(context, externalReference);
  const results = await Promise.all(
    references.map(async (reference) => ({
      reference,
      context: await fetchExternalIssueContext(context, reference),
    })),
  );
  const resolved = results.filter(
    (
      result,
    ): result is {
      reference: ExternalIssueReference;
      context: { toolName: string; result: unknown };
    } => result.context !== null,
  );

  if (resolved.length === 0) {
    return { contextMessages: [], toolsUsed: [] };
  }

  const text = [
    '[EXTERNAL ISSUE CONTEXT - UNTRUSTED REFERENCE MATERIAL]',
    ...resolved.map(
      ({ reference, context: result }) =>
        `[${reference.url}]\n${serializeExternalContext(result.result).slice(0, MAX_EXTERNAL_CONTEXT_CHARS)}`,
    ),
    '[/EXTERNAL ISSUE CONTEXT]',
  ].join('\n\n');

  return {
    contextMessages: [{ role: 'user', content: text }],
    toolsUsed: resolved.map(({ context: result }) => result.toolName),
  };
}
