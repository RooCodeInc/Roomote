import {
  type AcpPersistedEnvelope,
  ACP_ENVELOPE_EVENT_TYPES,
  asBoolean,
  asRecord,
  asString,
  buildPullRequestUrl,
  parsePullRequestUrl,
  sourceControlProviderDescriptors,
  type SourceControlProvider,
} from '@roomote/types';
import { z } from 'zod';

/**
 * Represents a pull request parsed from command output or free text.
 */
export interface ParsedPR {
  url: string;
  repository: string;
  number: number;
  provider: SourceControlProvider;
  host: string;
}

/**
 * Tool result `title`/`toolName` values that authoritatively deliver a created
 * PR (the `create-pr` / `create-draft-pr` deliverables), as opposed to an
 * execute tool that merely ran a `gh` command.
 */
const AUTHORITATIVE_PR_RESULT_NAMES = new Set(['create-draft-pr', 'create-pr']);

/**
 * Deliberately unanchored: callers that need false-positive protection are
 * responsible for constraining when this parser runs, usually via command
 * guards like `gh pr create` / `gh pr list` detection.
 */
const HTTPS_URL_CANDIDATE_REGEX = /https:\/\/[^\s<>"']+/g;
const GH_PR_CREATE_COMMAND_REGEX = /\bgh\s+pr\s+create\b/;
const GH_PR_CHECKOUT_COMMAND_REGEX = /\bgh\s+pr\s+checkout\b/;
const GH_PR_LIST_COMMAND_REGEX = /\bgh\s+pr\s+list\b/;
const GH_REPO_FLAG_REGEX = /(?:--repo|-R)\s+["']?([^"'\s]+)["']?/;
const GH_PR_CHECKOUT_NUMBER_REGEX =
  /\bgh\s+pr\s+checkout\s+["']?(\d+)["']?(?=\s|$)/;
const AUTHORITATIVE_PR_TOOL_RESULT_SCHEMA = z
  .object({
    url: z.string(),
    headRefName: z.string(),
    title: z.string().optional(),
    isDraft: z.boolean().optional(),
    baseRefName: z.string().optional(),
    number: z.number().int().positive().optional(),
    labels: z.array(z.string()).optional(),
  })
  .passthrough();
const AUTHORITATIVE_PR_TOOL_RESULT_ALLOWED_KEYS = new Set([
  'baseRefName',
  'headRefName',
  'isDraft',
  'labels',
  'number',
  'title',
  'url',
]);

const ANSI_ESCAPE_PATTERN = String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))`;
const ANSI_ESCAPE_REGEX = new RegExp(ANSI_ESCAPE_PATTERN, 'g');

function stripAnsiSequences(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_REGEX, '').replaceAll('\r', '');
}

function trimTrailingUrlPunctuation(url: string): string {
  let trimmed = url;

  while (
    trimmed.length > 0 &&
    ['.', ',', '!', '?', ';', ':', ')', ']', '}', '`'].includes(
      trimmed.at(-1) ?? '',
    )
  ) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed;
}

function toParsedPR(input: {
  provider: SourceControlProvider;
  host?: string;
  repositoryFullName: string;
  number: number;
}): ParsedPR | null {
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return null;
  }

  const host =
    input.host ?? sourceControlProviderDescriptors[input.provider].defaultHost;

  return {
    url: buildPullRequestUrl({
      provider: input.provider,
      host,
      repositoryFullName: input.repositoryFullName,
      number: input.number,
    }),
    repository: input.repositoryFullName,
    number: input.number,
    provider: input.provider,
    host,
  };
}

function parsePRFromUrlCandidate(url: string): ParsedPR | null {
  const candidate = trimTrailingUrlPunctuation(url);
  const ref = parsePullRequestUrl(candidate);

  if (!ref) {
    return null;
  }

  return toParsedPR(ref);
}

function githubParsedPR(repository: string, number: number): ParsedPR | null {
  return toParsedPR({
    provider: 'github',
    host: 'github.com',
    repositoryFullName: repository,
    number,
  });
}

/**
 * Parses a pull request / merge request URL from command output text.
 *
 * Returns a {@link ParsedPR} when the trimmed output contains a recognized
 * provider PR URL (GitHub, GitLab, Gitea, or Azure DevOps), or `null` otherwise.
 */
export function parsePRFromOutput(output: string): ParsedPR | null {
  const cleaned = stripAnsiSequences(output);
  const matches = cleaned.matchAll(HTTPS_URL_CANDIDATE_REGEX);

  for (const match of matches) {
    const parsed = parsePRFromUrlCandidate(match[0] ?? '');

    if (parsed) {
      return parsed;
    }
  }

  return null;
}

/**
 * Parses PR URLs from an execute-tool result that ran `gh pr create`.
 *
 * This keeps the existing strict bare-URL behavior, then falls back to
 * extracting any PR URLs that appear on their own output line when the
 * command string shows that `gh pr create` ran somewhere in the shell
 * command.
 */
export function parsePRsFromGhPrCreateToolResult({
  command,
  output,
}: {
  command?: string | null;
  output: string;
}): ParsedPR[] {
  if (!command || !GH_PR_CREATE_COMMAND_REGEX.test(command)) {
    return [];
  }

  const normalizedOutput = stripAnsiSequences(output).trim();
  const strictPr = parsePRFromOutput(normalizedOutput);

  if (strictPr && strictPr.url === normalizedOutput) {
    return [strictPr];
  }

  const prs: ParsedPR[] = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const parsed = parsePRFromOutput(line);

    if (!parsed || seen.has(parsed.url)) {
      continue;
    }

    seen.add(parsed.url);
    prs.push(parsed);
  }

  return prs;
}

/**
 * Parses PR identity from a successful `gh pr checkout` execute-tool result.
 *
 * The checkout command already carries both the repository and PR number, so we
 * only accept output that looks like a successful git branch checkout to avoid
 * linking failed or speculative checkout attempts.
 */
export function parsePRsFromGhPrCheckoutToolResult({
  command,
  output,
  fallbackRepository,
}: {
  command?: string | null;
  output: string;
  fallbackRepository?: string | null;
}): ParsedPR[] {
  if (!command || !GH_PR_CHECKOUT_COMMAND_REGEX.test(command)) {
    return [];
  }

  const repo = parseRepoFromCommand(command) ?? fallbackRepository ?? null;
  const prNumberMatch = command.match(GH_PR_CHECKOUT_NUMBER_REGEX);
  const prNumber = Number.parseInt(prNumberMatch?.[1] ?? '', 10);
  const normalizedOutput = stripAnsiSequences(output);
  const hasSuccessfulCheckoutSignal =
    normalizedOutput.includes('Switched to a new branch') ||
    normalizedOutput.includes('Switched to branch') ||
    normalizedOutput.includes('Already on') ||
    normalizedOutput.includes('set up to track');

  if (
    !repo ||
    Number.isNaN(prNumber) ||
    prNumber <= 0 ||
    !hasSuccessfulCheckoutSignal
  ) {
    return [];
  }

  const parsed = githubParsedPR(repo, prNumber);

  return parsed ? [parsed] : [];
}

/**
 * Parses authoritative PR metadata emitted by the PR-delivery flow itself.
 *
 * This intentionally requires the structured result shape returned by the
 * create/refresh PR path so arbitrary JSON blobs or assistant narration do not
 * create false task↔PR links.
 */
export function parsePRsFromAuthoritativeToolResultOutput(
  output: string,
): ParsedPR[] {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(stripAnsiSequences(output).trim());
  } catch {
    return [];
  }

  const parsedResult =
    AUTHORITATIVE_PR_TOOL_RESULT_SCHEMA.safeParse(parsedJson);

  if (!parsedResult.success) {
    return [];
  }

  const parsedKeys = Object.keys(parsedResult.data);

  if (
    parsedKeys.some(
      (key) => !AUTHORITATIVE_PR_TOOL_RESULT_ALLOWED_KEYS.has(key),
    )
  ) {
    return [];
  }

  const parsedPr = parsePRFromUrlCandidate(parsedResult.data.url);

  return parsedPr ? [parsedPr] : [];
}

export function parseRepoFromCommand(command: string): string | null {
  const match = command.match(GH_REPO_FLAG_REGEX);
  const repo = match?.[1];

  return repo && repo.includes('/') ? repo : null;
}

function collectPRsFromJsonValue(
  value: unknown,
  prs: ParsedPR[],
  seen: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPRsFromJsonValue(entry, prs, seen);
    }

    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  const urlValue = record.url;

  if (typeof urlValue === 'string') {
    const parsed = parsePRFromUrlCandidate(urlValue);

    if (parsed && !seen.has(parsed.url)) {
      seen.add(parsed.url);
      prs.push(parsed);
    }
  }

  for (const child of Object.values(record)) {
    collectPRsFromJsonValue(child, prs, seen);
  }
}

/**
 * Parses PR URLs from branch-scoped `gh pr list --json ...` output.
 *
 * This is the existing-PR refresh path used before `gh pr edit`: the workflow
 * first discovers the open PR for the current branch, then edits it. We only
 * trust branch-scoped list calls with JSON output to avoid linking arbitrary PR
 * lookups.
 */
export function parsePRsFromGhPrListToolResult({
  command,
  output,
}: {
  command?: string | null;
  output: string;
}): ParsedPR[] {
  if (
    !command ||
    !GH_PR_LIST_COMMAND_REGEX.test(command) ||
    !command.includes('--head') ||
    !command.includes('--json')
  ) {
    return [];
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(stripAnsiSequences(output).trim());
  } catch {
    return [];
  }

  if (
    (typeof parsedJson === 'number' ||
      (typeof parsedJson === 'string' && /^\d+$/.test(parsedJson.trim()))) &&
    command.includes('--jq')
  ) {
    const repo = parseRepoFromCommand(command);
    const number =
      typeof parsedJson === 'number'
        ? parsedJson
        : Number.parseInt(parsedJson.trim(), 10);

    if (!repo || Number.isNaN(number) || number <= 0) {
      return [];
    }

    const parsed = githubParsedPR(repo, number);

    return parsed ? [parsed] : [];
  }

  const prs: ParsedPR[] = [];
  const seen = new Set<string>();

  collectPRsFromJsonValue(parsedJson, prs, seen);

  return prs;
}

/**
 * Parses one or more pull request / merge request URLs from arbitrary text.
 *
 * This supports assistant summaries that embed PR links in markdown (e.g.
 * backticks, inline prose, markdown links). Parsed URLs are normalized to the
 * canonical provider-specific shape and deduplicated.
 */
export function parsePRsFromText(text: string): ParsedPR[] {
  const matches = stripAnsiSequences(text).matchAll(HTTPS_URL_CANDIDATE_REGEX);
  const prs: ParsedPR[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const candidate = match[0] ?? '';

    if (!candidate) {
      continue;
    }

    const parsed = parsePRFromUrlCandidate(candidate);

    if (!parsed) {
      continue;
    }

    if (seen.has(parsed.url)) {
      continue;
    }

    seen.add(parsed.url);
    prs.push(parsed);
  }

  return prs;
}

/**
 * Interprets a single tool-result envelope into the pull request(s) it links,
 * sequencing the leaf parsers above in one place so every caller agrees on what
 * counts as a PR link and in what order. Both the server (which persists the
 * link onto the cloud-job row) and the worker (which caches it) call this, so
 * the dispatch logic and the authoritative-result set never drift apart.
 *
 * The only environment-specific input is the fallback repository for a bare
 * `gh pr checkout <number>` with no `--repo` flag: the server reads it from the
 * cloud-job row (async), the worker passes its payload repo. The resolver is
 * invoked only when that exact case is reached, so callers pay nothing for it
 * on every other envelope.
 */
export async function detectPullRequestsFromToolResultEnvelope(input: {
  envelope: AcpPersistedEnvelope;
  resolveCheckoutFallbackRepository?: () =>
    | string
    | null
    | Promise<string | null>;
}): Promise<ParsedPR[]> {
  const { envelope } = input;

  if (envelope.eventType !== ACP_ENVELOPE_EVENT_TYPES.ToolResult) {
    return [];
  }

  const payload = asRecord(envelope.payload);

  if (!payload) {
    return [];
  }

  const output = asString(payload.output);

  if (!output || output.trim().length === 0) {
    return [];
  }

  const isExecute =
    asBoolean(payload.isExecute) === true ||
    asString(payload.kind) === 'execute';

  if (!isExecute) {
    const title = asString(payload.title);
    const toolName =
      asString(payload.toolName) ?? asString(payload.mcpToolName);
    const isAuthoritativePrDeliveryResult =
      (typeof title === 'string' && AUTHORITATIVE_PR_RESULT_NAMES.has(title)) ||
      (typeof toolName === 'string' &&
        AUTHORITATIVE_PR_RESULT_NAMES.has(toolName));

    if (!isAuthoritativePrDeliveryResult) {
      return [];
    }

    return parsePRsFromAuthoritativeToolResultOutput(output);
  }

  const command = asString(payload.command);

  const createPrs = parsePRsFromGhPrCreateToolResult({ command, output });

  if (createPrs.length > 0) {
    return createPrs;
  }

  const explicitCheckoutRepository = command
    ? parseRepoFromCommand(command)
    : null;
  const checkoutFallbackRepository =
    command?.includes('gh pr checkout') &&
    !explicitCheckoutRepository &&
    input.resolveCheckoutFallbackRepository
      ? ((await input.resolveCheckoutFallbackRepository()) ?? null)
      : null;

  const checkoutPrs = parsePRsFromGhPrCheckoutToolResult({
    command,
    output,
    fallbackRepository: checkoutFallbackRepository,
  });

  if (checkoutPrs.length > 0) {
    return checkoutPrs;
  }

  return parsePRsFromGhPrListToolResult({ command, output });
}
