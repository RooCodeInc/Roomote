import { compileAuthorshipRulesSchema } from '../../../src/server/authorship-rules';
import { resolveAvailableRepositories } from '../prompts/compile-authorship';

interface AuthorshipRuleActor {
  userId?: string | null;
  displayName?: string | null;
  githubLogin?: string | null;
  githubUserId?: number | null;
}

interface AuthorshipRule {
  label?: string;
  conditions?: {
    sourceKinds?: string[];
    taskTypes?: string[];
    repositoryFullNames?: string[];
    humanCreated?: boolean | null;
  };
  author?: {
    mode?: string;
    actor?: AuthorshipRuleActor | null;
  };
  prOwner?: {
    mode?: string;
    actor?: AuthorshipRuleActor | null;
  };
  rationale?: string;
}

interface AuthorshipIssue {
  severity?: string;
  message?: string;
}

interface AuthorshipResponse {
  confidence?: number | null;
  issues?: AuthorshipIssue[];
  rules?: AuthorshipRule[];
}

interface AssertionResult {
  pass: boolean;
  score: number;
  reason: string;
}

interface ExpectedRuleMatch {
  authorMode?: string;
  authorGithubLogin?: string | null;
  prOwnerMode?: string;
  prOwnerGithubLogin?: string | null;
  sourceKinds?: string[];
  taskTypes?: string[];
  repositoryFullNames?: string[];
  humanCreated?: boolean | null;
}

interface ExpectedAuthorshipResult {
  exactRuleCount?: number;
  minRuleCount?: number;
  maxRuleCount?: number;
  requireAnyIssue?: boolean;
  requireErrorIssue?: boolean;
  requireWarningIssue?: boolean;
  maxErrorCount?: number;
  expectedRules?: ExpectedRuleMatch[];
}

interface PromptVarsForRepositoryResolution {
  availableRepositoriesKey?: string;
  availableRepositories?: string[];
}

function hasOwn(object: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, property);
}

function resolveExplicitAvailableRepositories(
  vars: Record<string, unknown>,
): string[] | undefined {
  if (
    !hasOwn(vars, 'availableRepositoriesKey') &&
    !hasOwn(vars, 'availableRepositories')
  ) {
    return undefined;
  }

  return resolveAvailableRepositories({
    authorshipInstructions: '',
    ...(vars as PromptVarsForRepositoryResolution),
  });
}

function extractJson(output: string): AuthorshipResponse | null {
  try {
    const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch?.[1]) {
      return JSON.parse(codeBlockMatch[1].trim()) as AuthorshipResponse;
    }

    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch?.[0]) {
      return JSON.parse(jsonMatch[0]) as AuthorshipResponse;
    }

    return null;
  } catch {
    return null;
  }
}

function isValidAuthorshipJson(output: string): AssertionResult {
  const json = extractJson(output);
  if (!json) {
    return {
      pass: false,
      score: 0,
      reason: 'Response is not valid JSON',
    };
  }

  const parsed = compileAuthorshipRulesSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');

    return {
      pass: false,
      score: 0,
      reason: `Response does not match compileAuthorshipRulesSchema: ${issues}`,
    };
  }

  return {
    pass: true,
    score: 1,
    reason: 'Response matches compileAuthorshipRulesSchema',
  };
}

function normalizeStringArray(
  values: string[] | undefined,
): string[] | undefined {
  if (!values) {
    return undefined;
  }

  return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizeRuleArray(
  values: string[] | undefined,
  options?: {
    availableRepositories?: string[];
    filterUnavailableRepositories?: boolean;
  },
): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const deduped = [...new Set(values)];
  const filtered =
    options?.filterUnavailableRepositories &&
    options.availableRepositories !== undefined
      ? deduped.filter((value) =>
          options.availableRepositories?.includes(value),
        )
      : deduped;

  return normalizeStringArray(filtered);
}

function arraysMatchExactly(
  actual: string[] | undefined,
  expected: string[] | undefined,
  options?: {
    availableRepositories?: string[];
    filterUnavailableRepositories?: boolean;
  },
): boolean {
  if (expected === undefined) {
    return true;
  }

  const normalizedActual = normalizeRuleArray(actual, options) ?? [];
  const normalizedExpected = normalizeRuleArray(expected, options) ?? [];

  return (
    JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected)
  );
}

function ruleMatchesExpectation(
  rule: AuthorshipRule,
  expected: ExpectedRuleMatch,
  options?: {
    availableRepositories?: string[];
  },
): boolean {
  if (expected.authorMode && rule.author?.mode !== expected.authorMode) {
    return false;
  }

  if (
    expected.authorGithubLogin !== undefined &&
    (rule.author?.actor?.githubLogin ?? null) !== expected.authorGithubLogin
  ) {
    return false;
  }

  if (expected.prOwnerMode && rule.prOwner?.mode !== expected.prOwnerMode) {
    return false;
  }

  if (
    expected.prOwnerGithubLogin !== undefined &&
    (rule.prOwner?.actor?.githubLogin ?? null) !== expected.prOwnerGithubLogin
  ) {
    return false;
  }

  if (
    !arraysMatchExactly(rule.conditions?.sourceKinds, expected.sourceKinds) ||
    !arraysMatchExactly(rule.conditions?.taskTypes, expected.taskTypes) ||
    !arraysMatchExactly(
      rule.conditions?.repositoryFullNames,
      expected.repositoryFullNames,
      {
        availableRepositories: options?.availableRepositories,
        filterUnavailableRepositories:
          options?.availableRepositories !== undefined,
      },
    )
  ) {
    return false;
  }

  if (
    expected.humanCreated !== undefined &&
    (rule.conditions?.humanCreated ?? null) !== expected.humanCreated
  ) {
    return false;
  }

  return true;
}

function matchesExpectedAuthorshipResult(
  output: string,
  context: { vars: Record<string, unknown> },
): AssertionResult {
  const json = extractJson(output);
  if (!json) {
    return {
      pass: false,
      score: 0,
      reason: 'Invalid JSON response',
    };
  }

  const expected = context.vars.expected as
    | ExpectedAuthorshipResult
    | undefined;
  if (!expected) {
    return {
      pass: false,
      score: 0,
      reason: 'No expected object found in test vars',
    };
  }

  const parsed = compileAuthorshipRulesSchema.safeParse(json);
  if (!parsed.success) {
    return {
      pass: false,
      score: 0,
      reason: 'Invalid JSON response for compileAuthorshipRulesSchema',
    };
  }

  const rules = parsed.data.rules;
  const issues = parsed.data.issues;
  const availableRepositories = resolveExplicitAvailableRepositories(
    context.vars,
  );
  const errorCount = issues.filter(
    (issue) => issue.severity === 'error',
  ).length;
  const warningCount = issues.filter(
    (issue) => issue.severity === 'warning',
  ).length;
  const issueCount = issues.length;

  if (
    typeof expected.exactRuleCount === 'number' &&
    rules.length !== expected.exactRuleCount
  ) {
    return {
      pass: false,
      score: 0,
      reason: `Expected exactly ${expected.exactRuleCount} rule(s), got ${rules.length}`,
    };
  }

  if (
    typeof expected.minRuleCount === 'number' &&
    rules.length < expected.minRuleCount
  ) {
    return {
      pass: false,
      score: 0,
      reason: `Expected at least ${expected.minRuleCount} rule(s), got ${rules.length}`,
    };
  }

  if (
    typeof expected.maxRuleCount === 'number' &&
    rules.length > expected.maxRuleCount
  ) {
    return {
      pass: false,
      score: 0,
      reason: `Expected at most ${expected.maxRuleCount} rule(s), got ${rules.length}`,
    };
  }

  if (expected.requireErrorIssue && errorCount === 0) {
    return {
      pass: false,
      score: 0,
      reason: 'Expected at least one error issue',
    };
  }

  if (expected.requireWarningIssue && warningCount === 0) {
    return {
      pass: false,
      score: 0,
      reason: 'Expected at least one warning issue',
    };
  }

  if (expected.requireAnyIssue && issueCount === 0) {
    return {
      pass: false,
      score: 0,
      reason: 'Expected at least one issue',
    };
  }

  if (
    typeof expected.maxErrorCount === 'number' &&
    errorCount > expected.maxErrorCount
  ) {
    return {
      pass: false,
      score: 0,
      reason: `Expected at most ${expected.maxErrorCount} error issue(s), got ${errorCount}`,
    };
  }

  for (const expectedRule of expected.expectedRules ?? []) {
    const matched = rules.some((rule) =>
      ruleMatchesExpectation(rule, expectedRule, {
        availableRepositories,
      }),
    );

    if (!matched) {
      return {
        pass: false,
        score: 0,
        reason: `No compiled rule matched expectation ${JSON.stringify(expectedRule)}`,
      };
    }
  }

  return {
    pass: true,
    score: 1,
    reason: `Matched ${rules.length} rule(s), ${errorCount} error(s), and ${warningCount} warning(s) as expected`,
  };
}

export { extractJson, isValidAuthorshipJson, matchesExpectedAuthorshipResult };
