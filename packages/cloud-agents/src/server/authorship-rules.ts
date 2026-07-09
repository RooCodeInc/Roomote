import {
  type AuthorshipRuleActor,
  type AuthorshipRuleIssue,
  type CommitAuthorKind,
  type CompiledAuthorshipRule,
  type TaskInitiator,
  type TaskInitiatorKind,
  type TaskSurface,
  type TaskWorkflow,
  TASK_INITIATOR_KINDS,
  TASK_SURFACES,
  TASK_WORKFLOWS,
} from '@roomote/types';
import { z } from 'zod';

import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from './non-task-provider-usage';

const MAX_AUTHORSHIP_RULES = 12;

export const authorshipRuleSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    conditions: z
      .object({
        surfaces: z
          .array(z.enum(TASK_SURFACES))
          .max(TASK_SURFACES.length)
          .default([]),
        workflows: z
          .array(z.enum(TASK_WORKFLOWS))
          .max(TASK_WORKFLOWS.length)
          .default([]),
        repositoryFullNames: z
          .array(z.string().trim().min(1))
          .max(16)
          .default([]),
        initiatorKinds: z
          .array(z.enum(TASK_INITIATOR_KINDS))
          .max(TASK_INITIATOR_KINDS.length)
          .default([]),
      })
      .default({
        surfaces: [],
        workflows: [],
        repositoryFullNames: [],
        initiatorKinds: [],
      }),
    author: z
      .object({
        mode: z.enum([
          'unchanged',
          'roomote',
          'matched_human',
          'specific_user',
        ]),
        actor: z
          .object({
            userId: z.string().trim().min(1).nullable().optional(),
            displayName: z.string().trim().min(1).nullable().optional(),
            githubLogin: z.string().trim().min(1).nullable().optional(),
            githubUserId: z.number().int().positive().nullable().optional(),
          })
          .nullable()
          .optional(),
      })
      .default({
        mode: 'unchanged',
        actor: null,
      }),
    prOwner: z
      .object({
        mode: z.enum([
          'unchanged',
          'inherit_author',
          'none',
          'matched_human',
          'specific_user',
        ]),
        actor: z
          .object({
            userId: z.string().trim().min(1).nullable().optional(),
            displayName: z.string().trim().min(1).nullable().optional(),
            githubLogin: z.string().trim().min(1).nullable().optional(),
            githubUserId: z.number().int().positive().nullable().optional(),
          })
          .nullable()
          .optional(),
      })
      .default({
        mode: 'unchanged',
        actor: null,
      }),
    rationale: z.string().trim().min(1).max(240),
  })
  .strict();

export const compileAuthorshipRulesSchema = z
  .object({
    confidence: z.number().nullable().optional(),
    issues: z
      .array(
        z.object({
          severity: z.enum(['error', 'warning']),
          message: z.string().trim().min(1).max(240),
        }),
      )
      .max(12)
      .default([]),
    rules: z.array(authorshipRuleSchema).max(MAX_AUTHORSHIP_RULES).default([]),
  })
  .strict();

export const AUTHORSHIP_RULES_SYSTEM_PROMPT = `
You compile organization-level authorship and PR ownership instructions for Roomote into structured rules.

Important defaults:
- Roomote is the default commit author for automation-initiated tasks.
- If a task is user-initiated and no rule overrides that, the initiating human should be the commit author.
- PR assignee inherits the commit author's GitHub login by default.

Use rules only for explicit overrides or routing.

Allowed conditions:
- surface: ${TASK_SURFACES.join(', ')}
- workflow: ${TASK_WORKFLOWS.join(', ')}
- repository full name
- initiator kind: ${TASK_INITIATOR_KINDS.join(', ')} ('user' means a human initiated the task, 'automation' means an automation initiated it)

Allowed author decisions:
- unchanged
- roomote
- matched_human
- specific_user

Allowed PR owner decisions:
- unchanged
- inherit_author
- none
- matched_human
- specific_user

Rules must be concrete and deterministic.
If an instruction is ambiguous, subjective, internally conflicting, or lacks enough detail to compile deterministically, do not guess.
In those cases, return no rules for the ambiguous portion and include at least one error issue that explains what is unclear.
If only part of the instruction is ambiguous but another part is concrete, compile only the concrete part and include a warning issue for the ambiguous remainder.
If an instruction mixes valid and invalid repositories, or mixes a concrete clause with an un-compilable clause, keep the valid compiled rules and use warning issues for only the discarded portions. Use error issues only when the whole instruction or clause cannot be compiled into any rule.
Only use specific_user when the user is present in the provided available users list.
For author decisions, only use specific_user when the available user has both a GitHub login and a numeric GitHub user ID.
For PR owner decisions, a GitHub login is sufficient even when the numeric GitHub user ID is null.
A missing numeric GitHub user ID blocks only author.mode = specific_user. It does not block prOwner.mode = specific_user.
If a user is referenced only as a PR owner, never emit an authorship error about that missing numeric GitHub user ID.
When referencing a repository, return the full repository name exactly as listed.
Do not invent users, repository names, surfaces, workflows, or initiator kinds.
Return structured output only.
`.trim();

export type AvailableSpecificUser = AuthorshipRuleActor;

export type CompileAuthorshipRulesInput = {
  authorshipInstructions: string;
  availableRepositories: string[];
  availableUsers: AvailableSpecificUser[];
  userId?: string | null;
};

type CompiledAuthorshipRulesResult = {
  confidence: number | null;
  isValid: boolean;
  issues: AuthorshipRuleIssue[];
  rules: CompiledAuthorshipRule[];
};

/**
 * The persisted 5-column commit-author block stamped onto tasks at enqueue.
 */
export type CommitAuthorSelection = {
  commitAuthorKind: CommitAuthorKind;
  commitAuthorUserId: string | null;
  commitAuthorLogin: string | null;
  commitAuthorExternalId: string | null;
  prAssigneeLogin: string | null;
};

function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalNumber(
  value: number | null | undefined,
): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function formatAvailableUsers(users: AvailableSpecificUser[]): string {
  if (users.length === 0) {
    return '- No available linked GitHub users';
  }

  return users
    .map((user) => {
      const parts = [
        user.userId ?? 'unknown-user-id',
        user.displayName ?? 'Unknown User',
        user.githubLogin ?? 'no-github-login',
        user.githubUserId ?? 'no-github-user-id',
      ];
      return `- ${parts.join(' | ')}`;
    })
    .join('\n');
}

export function buildCompilePrompt(input: CompileAuthorshipRulesInput): string {
  const repositoryLines =
    input.availableRepositories.length > 0
      ? input.availableRepositories.map((repo) => `- ${repo}`).join('\n')
      : '- No repositories available';

  return [
    'Authorship instructions:',
    input.authorshipInstructions.trim(),
    '',
    'Available repositories:',
    repositoryLines,
    '',
    'Available linked GitHub users:',
    formatAvailableUsers(input.availableUsers),
  ].join('\n');
}

function resolveSpecificUserActor(
  actor:
    | {
        userId?: string | null;
        displayName?: string | null;
        githubLogin?: string | null;
        githubUserId?: number | null;
      }
    | null
    | undefined,
  availableUsers: AvailableSpecificUser[],
): AuthorshipRuleActor | null {
  if (!actor) {
    return null;
  }

  const requestedUserId = normalizeOptionalText(actor.userId);
  const requestedGithubLogin = normalizeOptionalText(actor.githubLogin);

  const matchedUser =
    availableUsers.find((user) => user.userId === requestedUserId) ??
    availableUsers.find((user) => user.githubLogin === requestedGithubLogin);

  return matchedUser ?? null;
}

function normalizeCompiledRule(
  input: z.infer<typeof authorshipRuleSchema>,
  index: number,
  params: {
    availableRepositories: string[];
    availableUsers: AvailableSpecificUser[];
  },
  issues: AuthorshipRuleIssue[],
): CompiledAuthorshipRule | null {
  const repositorySet = new Set(params.availableRepositories);
  const repositoryFullNames = dedupeStrings(
    input.conditions.repositoryFullNames,
  ).filter((repository) => repositorySet.has(repository));

  const filteredOutRepositories = input.conditions.repositoryFullNames.filter(
    (repository) => !repositorySet.has(repository.trim()),
  );

  for (const repository of filteredOutRepositories) {
    issues.push({
      severity: 'warning',
      message: `Ignored authorship rule repository "${repository}" because it is not in the available repository list.`,
    });
  }

  const authorMode = input.author.mode;
  const prOwnerMode = input.prOwner.mode;
  const authorActor =
    authorMode === 'specific_user'
      ? resolveSpecificUserActor(input.author.actor, params.availableUsers)
      : null;
  const prOwnerActor =
    prOwnerMode === 'specific_user'
      ? resolveSpecificUserActor(input.prOwner.actor, params.availableUsers)
      : null;

  if (authorMode === 'specific_user' && !authorActor) {
    issues.push({
      severity: 'warning',
      message: `Ignored the specific author on rule "${input.label}" because it does not match an available linked GitHub user.`,
    });
  }

  if (prOwnerMode === 'specific_user' && !prOwnerActor) {
    issues.push({
      severity: 'warning',
      message: `Ignored the specific PR owner on rule "${input.label}" because it does not match an available linked GitHub user.`,
    });
  }

  if (
    (authorMode === 'specific_user' && !authorActor) ||
    (prOwnerMode === 'specific_user' && !prOwnerActor)
  ) {
    if (
      (authorMode === 'specific_user' ? authorActor === null : false) &&
      (prOwnerMode === 'specific_user' ? prOwnerActor === null : false)
    ) {
      return null;
    }
  }

  if (authorMode === 'unchanged' && prOwnerMode === 'unchanged') {
    issues.push({
      severity: 'warning',
      message: `Ignored rule "${input.label}" because it does not change authorship or PR ownership.`,
    });
    return null;
  }

  return {
    id: `authorship-rule-${index + 1}`,
    priority: index,
    label: input.label,
    conditions: {
      surfaces: [...new Set(input.conditions.surfaces)],
      workflows: [...new Set(input.conditions.workflows)],
      repositoryFullNames,
      initiatorKinds: [...new Set(input.conditions.initiatorKinds)],
    },
    author:
      authorMode === 'specific_user' && authorActor
        ? { mode: authorMode, actor: authorActor }
        : authorMode === 'specific_user'
          ? { mode: 'unchanged', actor: null }
          : { mode: authorMode, actor: null },
    prOwner:
      prOwnerMode === 'specific_user' && prOwnerActor
        ? { mode: prOwnerMode, actor: prOwnerActor }
        : prOwnerMode === 'specific_user'
          ? { mode: 'unchanged', actor: null }
          : { mode: prOwnerMode, actor: null },
    rationale: input.rationale,
  };
}

export async function compileAuthorshipRules(
  input: CompileAuthorshipRulesInput,
): Promise<CompiledAuthorshipRulesResult> {
  if (!normalizeOptionalText(input.authorshipInstructions)) {
    return {
      confidence: 1,
      isValid: true,
      issues: [],
      rules: [],
    };
  }

  const { object } = await generateTrackedNonTaskObject({
    userId: input.userId,
    surface: NON_TASK_INFERENCE_SURFACES.authorshipRulesCompilation,
    maxOutputTokens: 2048,
    schema: compileAuthorshipRulesSchema,
    system: AUTHORSHIP_RULES_SYSTEM_PROMPT,
    prompt: buildCompilePrompt(input),
  });

  const issues = [...object.issues];
  const rules = object.rules
    .map((rule, index) =>
      normalizeCompiledRule(
        rule,
        index,
        input,
        issues as AuthorshipRuleIssue[],
      ),
    )
    .filter((rule): rule is CompiledAuthorshipRule => Boolean(rule));

  const confidence =
    typeof object.confidence === 'number' && Number.isFinite(object.confidence)
      ? object.confidence
      : null;

  return {
    confidence,
    isValid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    rules,
  };
}

type AuthorIdentity = {
  kind: CommitAuthorKind;
  userId: string | null;
  githubLogin: string | null;
  githubExternalId: string | null;
  /** Rule that decided this author, null for the default resolution. */
  ruleId: string | null;
};

type PrOwnerIdentity = {
  mode: 'inherit_author' | 'none' | 'specific';
  githubLogin: string | null;
  ruleId: string | null;
};

export type EvaluateCommitAuthorInput = {
  compiledRules: CompiledAuthorshipRule[];
  initiator: TaskInitiator;
  /**
   * The linked user the initiator resolves to (initiator.userId or
   * initiator.matchedUserId), enriched with their latest GitHub identity.
   */
  matchedHumanActor: AuthorshipRuleActor | null;
  /**
   * Raw GitHub identity supplied by the launch for unlinked humans (e.g. the
   * PR author on conflict-resolution or webhook-review launches).
   */
  externalGithubIdentity?: {
    githubLogin?: string | null;
    githubUserId?: number | null;
  };
  workflow: TaskWorkflow;
  surface: TaskSurface;
  repositoryFullName: string | null;
};

function getInitiatorKind(initiator: TaskInitiator): TaskInitiatorKind {
  return initiator.kind;
}

function getDefaultAuthor(input: EvaluateCommitAuthorInput): AuthorIdentity {
  if (input.initiator.kind === 'automation') {
    return {
      kind: 'roomote',
      userId: null,
      githubLogin: null,
      githubExternalId: null,
      ruleId: null,
    };
  }

  if (input.matchedHumanActor?.userId) {
    return {
      kind: 'user',
      userId: input.matchedHumanActor.userId,
      githubLogin: normalizeOptionalText(input.matchedHumanActor.githubLogin),
      githubExternalId:
        normalizeOptionalNumber(input.matchedHumanActor.githubUserId) !== null
          ? String(input.matchedHumanActor.githubUserId)
          : null,
      ruleId: null,
    };
  }

  // Unlinked human. Preserve any GitHub identity so their noreply commits
  // survive; without one the git author falls back to Roomote at read time
  // while the task still displays the external actor.
  const githubLogin = normalizeOptionalText(
    input.externalGithubIdentity?.githubLogin,
  );
  const githubUserId = normalizeOptionalNumber(
    input.externalGithubIdentity?.githubUserId,
  );

  return {
    kind: 'external',
    userId: null,
    githubLogin,
    githubExternalId: githubUserId !== null ? String(githubUserId) : null,
    ruleId: null,
  };
}

function ruleMatches(
  rule: CompiledAuthorshipRule,
  input: EvaluateCommitAuthorInput,
): boolean {
  const { conditions } = rule;

  if (
    conditions.initiatorKinds.length > 0 &&
    !conditions.initiatorKinds.includes(getInitiatorKind(input.initiator))
  ) {
    return false;
  }

  if (
    conditions.surfaces.length > 0 &&
    !conditions.surfaces.includes(input.surface)
  ) {
    return false;
  }

  if (
    conditions.workflows.length > 0 &&
    !conditions.workflows.includes(input.workflow)
  ) {
    return false;
  }

  if (
    conditions.repositoryFullNames.length > 0 &&
    (!input.repositoryFullName ||
      !conditions.repositoryFullNames.includes(input.repositoryFullName))
  ) {
    return false;
  }

  return true;
}

function actorToAuthor(
  actor: AuthorshipRuleActor,
  ruleId: string,
): AuthorIdentity {
  const githubUserId = normalizeOptionalNumber(actor.githubUserId);

  return {
    kind: actor.userId ? 'user' : 'external',
    userId: actor.userId,
    githubLogin: normalizeOptionalText(actor.githubLogin),
    githubExternalId: githubUserId !== null ? String(githubUserId) : null,
    ruleId,
  };
}

function resolveAuthorDecision(params: {
  currentAuthor: AuthorIdentity;
  matchedHumanActor: AuthorshipRuleActor | null;
  rule: CompiledAuthorshipRule;
}): AuthorIdentity {
  switch (params.rule.author.mode) {
    case 'roomote':
      return {
        kind: 'roomote',
        userId: null,
        githubLogin: null,
        githubExternalId: null,
        ruleId: params.rule.id,
      };
    case 'matched_human':
      if (!params.matchedHumanActor?.userId) {
        return params.currentAuthor;
      }

      return actorToAuthor(params.matchedHumanActor, params.rule.id);
    case 'specific_user':
      if (!params.rule.author.actor) {
        return params.currentAuthor;
      }

      return actorToAuthor(params.rule.author.actor, params.rule.id);
    case 'unchanged':
    default:
      return params.currentAuthor;
  }
}

function resolvePrOwnerDecision(params: {
  currentOwner: PrOwnerIdentity;
  matchedHumanActor: AuthorshipRuleActor | null;
  rule: CompiledAuthorshipRule;
}): PrOwnerIdentity {
  switch (params.rule.prOwner.mode) {
    case 'inherit_author':
      return {
        mode: 'inherit_author',
        githubLogin: null,
        ruleId: params.rule.id,
      };
    case 'none':
      return {
        mode: 'none',
        githubLogin: null,
        ruleId: params.rule.id,
      };
    case 'matched_human':
      if (!params.matchedHumanActor) {
        return params.currentOwner;
      }

      return {
        mode: 'specific',
        githubLogin: normalizeOptionalText(
          params.matchedHumanActor.githubLogin,
        ),
        ruleId: params.rule.id,
      };
    case 'specific_user':
      if (!params.rule.prOwner.actor) {
        return params.currentOwner;
      }

      return {
        mode: 'specific',
        githubLogin: normalizeOptionalText(
          params.rule.prOwner.actor.githubLogin,
        ),
        ruleId: params.rule.id,
      };
    case 'unchanged':
    default:
      return params.currentOwner;
  }
}

/**
 * Evaluates the persisted commit-author block for a fresh task launch.
 *
 * Defaults:
 * - automation-initiated -> 'roomote'
 * - user-initiated with a linked user -> 'user' (+ their latest GitHub
 *   identity when available)
 * - user-initiated unlinked -> 'external' (with GitHub login + numeric id
 *   when the launch supplied one)
 *
 * Compiled rules (conditions: surfaces/workflows/repositoryFullNames/
 * initiatorKinds) can override the author to roomote or a specific user, and
 * can set or clear the PR assignee. The PR assignee defaults to the effective
 * author's GitHub login.
 */
export function evaluateCommitAuthor(
  input: EvaluateCommitAuthorInput,
): CommitAuthorSelection {
  let author = getDefaultAuthor(input);
  let prOwner: PrOwnerIdentity = {
    mode: 'inherit_author',
    githubLogin: null,
    ruleId: null,
  };
  let authorDecisionApplied = false;
  let prOwnerDecisionApplied = false;

  for (const rule of input.compiledRules) {
    if (!ruleMatches(rule, input)) {
      continue;
    }

    if (!authorDecisionApplied && rule.author.mode !== 'unchanged') {
      author = resolveAuthorDecision({
        currentAuthor: author,
        matchedHumanActor: input.matchedHumanActor,
        rule,
      });
      authorDecisionApplied = author.ruleId === rule.id;
    }

    if (!prOwnerDecisionApplied && rule.prOwner.mode !== 'unchanged') {
      prOwner = resolvePrOwnerDecision({
        currentOwner: prOwner,
        matchedHumanActor: input.matchedHumanActor,
        rule,
      });
      prOwnerDecisionApplied = prOwner.ruleId === rule.id;
    }

    if (authorDecisionApplied && prOwnerDecisionApplied) {
      break;
    }
  }

  const prAssigneeLogin =
    prOwner.mode === 'none'
      ? null
      : prOwner.mode === 'specific'
        ? prOwner.githubLogin
        : author.githubLogin;

  return {
    commitAuthorKind: author.kind,
    commitAuthorUserId: author.userId,
    commitAuthorLogin: author.githubLogin,
    commitAuthorExternalId: author.githubExternalId,
    prAssigneeLogin,
  };
}
