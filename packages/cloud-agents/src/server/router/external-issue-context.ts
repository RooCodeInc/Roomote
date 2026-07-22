import type { ModelMessage } from 'ai';

import { callRouterMcpTool } from './mcp-tool-call';
import type { RoutingContext } from './types';

const MAX_EXTERNAL_ISSUES = 2;
const MAX_EXTERNAL_CONTEXT_CHARS = 8_000;
const EXTERNAL_LOOKUP_TIMEOUT_MS = 8_000;

type ExternalIssueReference =
  | {
      serverId: 'github';
      url: string;
      owner: string;
      repository: string;
      issueNumber: number;
    }
  | {
      serverId: 'linear';
      url: string;
      identifier: string;
    };

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
      const parsedUrl = new URL(url);
      const githubMatch = parsedUrl.pathname.match(
        /^\/(?<owner>[^/]+)\/(?<repository>[^/]+)\/issues\/(?<issueNumber>\d+)(?:\/.*)?$/,
      );

      const owner = githubMatch?.groups?.owner;
      const repository = githubMatch?.groups?.repository;
      const issueNumber = githubMatch?.groups?.issueNumber;

      if (
        parsedUrl.hostname === 'github.com' &&
        owner &&
        repository &&
        issueNumber
      ) {
        references.push({
          serverId: 'github',
          url,
          owner,
          repository,
          issueNumber: Number(issueNumber),
        });
        continue;
      }

      const linearMatch = parsedUrl.pathname.match(
        /^\/[^/]+\/issue\/(?<identifier>[A-Za-z]+-\d+)(?:\/.*)?$/,
      );

      const identifier = linearMatch?.groups?.identifier;

      if (parsedUrl.hostname === 'linear.app' && identifier) {
        references.push({
          serverId: 'linear',
          url,
          identifier,
        });
      }
    } catch {
      // Ignore malformed links; routing can still proceed from the task text.
    }
  }

  return references;
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
  operation: Promise<T>,
  deadline: number,
): Promise<T | null> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return null;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
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

    if (reference.serverId === 'linear') {
      const result = await withExternalLookupTimeout(
        callRouterMcpTool({
          context,
          serverId: 'linear',
          toolName: 'get_issue',
          args: { id: reference.identifier },
        }),
        deadline,
      );

      return result === null ? null : { toolName: 'linear.get_issue', result };
    }

    const issueReadResult = await withExternalLookupTimeout(
      callRouterMcpTool({
        context,
        serverId: 'github',
        toolName: 'issue_read',
        args: {
          method: 'get',
          owner: reference.owner,
          repo: reference.repository,
          issue_number: reference.issueNumber,
        },
      }),
      deadline,
    );

    if (issueReadResult !== null) {
      return { toolName: 'github.issue_read', result: issueReadResult };
    }

    const getIssueResult = await withExternalLookupTimeout(
      callRouterMcpTool({
        context,
        serverId: 'github',
        toolName: 'get_issue',
        args: {
          owner: reference.owner,
          repo: reference.repository,
          issue_number: reference.issueNumber,
        },
      }),
      deadline,
    );

    return getIssueResult === null
      ? null
      : { toolName: 'github.get_issue', result: getIssueResult };
  } catch {
    // A disconnected integration or inaccessible issue must not block routing.
    return null;
  }
}

export async function gatherExternalIssueContext(
  context: RoutingContext,
): Promise<{ contextMessages: ModelMessage[]; toolsUsed: string[] }> {
  const references = parseExternalIssueReferences(context.taskDescription);
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
