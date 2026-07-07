import {
  type AuthorshipRuleActor,
  type AuthorshipRuleIssue,
  type CloudTask,
  type CompiledAuthorshipRule,
  type EffectiveAuthorKind,
  type EffectiveAuthorReason,
  type EffectivePrOwnerKind,
  type EffectivePrOwnerReason,
  type TaskAttributionSourceKind,
  TASK_ATTRIBUTION_SOURCE_KINDS,
  CloudTaskType,
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
        sourceKinds: z
          .array(z.enum(TASK_ATTRIBUTION_SOURCE_KINDS))
          .max(TASK_ATTRIBUTION_SOURCE_KINDS.length)
          .default([]),
        taskTypes: z.array(z.nativeEnum(CloudTaskType)).max(8).default([]),
        repositoryFullNames: z
          .array(z.string().trim().min(1))
          .max(16)
          .default([]),
        humanCreated: z.boolean().nullable().optional(),
      })
      .default({
        sourceKinds: [],
        taskTypes: [],
        repositoryFullNames: [],
        humanCreated: null,
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
- Roomote is the default author everywhere.
- If a task is human-created and no rule overrides that, the human should be the effective author.
- PR assignee inherits the effective author by default.

Use rules only for explicit overrides or routing.

Allowed conditions:
- source kind: slack, github, linear, web, automation, system
- task type
- repository full name
- whether the task is human-created

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
Do not invent users, repository names, source kinds, task types.
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

type EffectiveAuthorSnapshot = {
  attributionKind: 'matched_user' | 'unlinked_user' | 'automatic' | null;
  attributionSourceKind: TaskAttributionSourceKind | null;
  attributionSourceDisplayName: string | null;
  attributionSourceExternalId: string | null;
  attributedGithubLogin?: string | null;
  attributedGithubUserId?: number | null;
};

type EffectiveAuthorIdentity = AuthorshipRuleActor & {
  kind: EffectiveAuthorKind;
  reason: EffectiveAuthorReason;
  ruleId: string | null;
};

type EffectivePrOwnerIdentity = {
  kind: EffectivePrOwnerKind;
  userId: string | null;
  displayName: string | null;
  githubLogin: string | null;
  reason: EffectivePrOwnerReason;
  ruleId: string | null;
};

export type EffectiveAuthorshipEvaluation = {
  effectiveAuthorDisplayName: string | null;
  effectiveAuthorGithubLogin: string | null;
  effectiveAuthorGithubUserId: number | null;
  effectiveAuthorKind: EffectiveAuthorKind;
  effectiveAuthorReason: EffectiveAuthorReason;
  effectiveAuthorRuleId: string | null;
  effectiveAuthorUserId: string | null;
  effectivePrOwnerDisplayName: string | null;
  effectivePrOwnerGithubLogin: string | null;
  effectivePrOwnerKind: EffectivePrOwnerKind;
  effectivePrOwnerReason: EffectivePrOwnerReason;
  effectivePrOwnerRuleId: string | null;
  effectivePrOwnerUserId: string | null;
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
      sourceKinds: [...new Set(input.conditions.sourceKinds)],
      taskTypes: [...new Set(input.conditions.taskTypes)],
      repositoryFullNames,
      humanCreated:
        typeof input.conditions.humanCreated === 'boolean'
          ? input.conditions.humanCreated
          : null,
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

function isHumanCreated(snapshot: EffectiveAuthorSnapshot): boolean {
  return (
    snapshot.attributionKind === 'matched_user' ||
    snapshot.attributionKind === 'unlinked_user'
  );
}

function buildUnlinkedHumanDisplay(
  snapshot: EffectiveAuthorSnapshot,
): string | null {
  return (
    normalizeOptionalText(snapshot.attributionSourceDisplayName) ??
    normalizeOptionalText(snapshot.attributionSourceExternalId)
  );
}

function getDefaultEffectiveAuthor(input: {
  matchedHumanActor: AuthorshipRuleActor | null;
  snapshot: EffectiveAuthorSnapshot;
  task: CloudTask;
}): EffectiveAuthorIdentity {
  if (!isHumanCreated(input.snapshot)) {
    return {
      kind: 'roomote',
      userId: null,
      displayName: null,
      githubLogin: null,
      githubUserId: null,
      reason: 'default_roomote',
      ruleId: null,
    };
  }

  if (input.matchedHumanActor) {
    return {
      kind: 'human',
      userId: input.matchedHumanActor.userId,
      displayName:
        normalizeOptionalText(input.matchedHumanActor.displayName) ??
        buildUnlinkedHumanDisplay(input.snapshot),
      githubLogin: normalizeOptionalText(input.matchedHumanActor.githubLogin),
      githubUserId: normalizeOptionalNumber(
        input.matchedHumanActor.githubUserId,
      ),
      reason: 'human_created',
      ruleId: null,
    };
  }

  if (input.snapshot.attributionSourceKind === 'github') {
    return {
      kind: 'human',
      userId: null,
      displayName:
        buildUnlinkedHumanDisplay(input.snapshot) ??
        normalizeOptionalText(input.snapshot.attributedGithubLogin),
      githubLogin: normalizeOptionalText(input.snapshot.attributedGithubLogin),
      githubUserId: normalizeOptionalNumber(
        input.snapshot.attributedGithubUserId,
      ),
      reason: 'human_created',
      ruleId: null,
    };
  }

  return {
    kind: 'human',
    userId: null,
    displayName: buildUnlinkedHumanDisplay(input.snapshot),
    githubLogin: null,
    githubUserId: null,
    reason: 'human_created',
    ruleId: null,
  };
}

function ruleMatches(params: {
  humanCreated: boolean;
  repositoryFullName: string | null;
  rule: CompiledAuthorshipRule;
  snapshot: EffectiveAuthorSnapshot;
  task: CloudTask;
}): boolean {
  const { conditions } = params.rule;

  if (
    typeof conditions.humanCreated === 'boolean' &&
    conditions.humanCreated !== params.humanCreated
  ) {
    return false;
  }

  if (
    conditions.sourceKinds.length > 0 &&
    !conditions.sourceKinds.includes(
      params.snapshot.attributionSourceKind ?? 'system',
    )
  ) {
    return false;
  }

  if (
    conditions.taskTypes.length > 0 &&
    !conditions.taskTypes.includes(params.task.type)
  ) {
    return false;
  }

  if (
    conditions.repositoryFullNames.length > 0 &&
    (!params.repositoryFullName ||
      !conditions.repositoryFullNames.includes(params.repositoryFullName))
  ) {
    return false;
  }

  return true;
}

function resolveAuthorDecision(params: {
  currentAuthor: EffectiveAuthorIdentity;
  matchedHumanActor: AuthorshipRuleActor | null;
  rule: CompiledAuthorshipRule;
}): EffectiveAuthorIdentity {
  switch (params.rule.author.mode) {
    case 'roomote':
      return {
        kind: 'roomote',
        userId: null,
        displayName: null,
        githubLogin: null,
        githubUserId: null,
        reason: 'rule_roomote',
        ruleId: params.rule.id,
      };
    case 'matched_human':
      if (!params.matchedHumanActor) {
        return params.currentAuthor;
      }

      return {
        kind: 'human',
        userId: params.matchedHumanActor.userId,
        displayName: normalizeOptionalText(
          params.matchedHumanActor.displayName,
        ),
        githubLogin: normalizeOptionalText(
          params.matchedHumanActor.githubLogin,
        ),
        githubUserId: normalizeOptionalNumber(
          params.matchedHumanActor.githubUserId,
        ),
        reason: 'rule_matched_human',
        ruleId: params.rule.id,
      };
    case 'specific_user':
      if (!params.rule.author.actor) {
        return params.currentAuthor;
      }

      return {
        kind: 'human',
        userId: params.rule.author.actor.userId,
        displayName: normalizeOptionalText(
          params.rule.author.actor.displayName,
        ),
        githubLogin: normalizeOptionalText(
          params.rule.author.actor.githubLogin,
        ),
        githubUserId: normalizeOptionalNumber(
          params.rule.author.actor.githubUserId,
        ),
        reason: 'rule_specific_user',
        ruleId: params.rule.id,
      };
    case 'unchanged':
    default:
      return params.currentAuthor;
  }
}

function resolvePrOwnerDecision(params: {
  author: EffectiveAuthorIdentity;
  currentOwner: EffectivePrOwnerIdentity;
  matchedHumanActor: AuthorshipRuleActor | null;
  rule: CompiledAuthorshipRule;
}): EffectivePrOwnerIdentity {
  switch (params.rule.prOwner.mode) {
    case 'inherit_author':
      return {
        kind: 'inherit_author',
        userId: params.author.userId,
        displayName: params.author.displayName,
        githubLogin: params.author.githubLogin,
        reason: 'inherit_author',
        ruleId: params.rule.id,
      };
    case 'none':
      return {
        kind: 'none',
        userId: null,
        displayName: null,
        githubLogin: null,
        reason: 'rule_none',
        ruleId: params.rule.id,
      };
    case 'matched_human':
      if (!params.matchedHumanActor) {
        return params.currentOwner;
      }

      return {
        kind: 'specific_user',
        userId: params.matchedHumanActor.userId,
        displayName: normalizeOptionalText(
          params.matchedHumanActor.displayName,
        ),
        githubLogin: normalizeOptionalText(
          params.matchedHumanActor.githubLogin,
        ),
        reason: 'rule_matched_human',
        ruleId: params.rule.id,
      };
    case 'specific_user':
      if (!params.rule.prOwner.actor) {
        return params.currentOwner;
      }

      return {
        kind: 'specific_user',
        userId: params.rule.prOwner.actor.userId,
        displayName: normalizeOptionalText(
          params.rule.prOwner.actor.displayName,
        ),
        githubLogin: normalizeOptionalText(
          params.rule.prOwner.actor.githubLogin,
        ),
        reason: 'rule_specific_user',
        ruleId: params.rule.id,
      };
    case 'unchanged':
    default:
      return params.currentOwner;
  }
}

export function evaluateEffectiveAuthorship(input: {
  compiledRules: CompiledAuthorshipRule[];
  matchedHumanActor: AuthorshipRuleActor | null;
  snapshot: EffectiveAuthorSnapshot;
  task: CloudTask;
}): EffectiveAuthorshipEvaluation {
  const humanCreated = isHumanCreated(input.snapshot);
  const repositoryFullName = normalizeOptionalText(input.task.payload.repo);

  let author = getDefaultEffectiveAuthor({
    matchedHumanActor: input.matchedHumanActor,
    snapshot: input.snapshot,
    task: input.task,
  });
  let prOwner: EffectivePrOwnerIdentity = {
    kind: 'inherit_author',
    userId: author.userId,
    displayName: author.displayName,
    githubLogin: author.githubLogin,
    reason: 'inherit_author',
    ruleId: null,
  };
  let authorDecisionApplied = false;
  let prOwnerDecisionApplied = false;

  for (const rule of input.compiledRules) {
    if (
      !ruleMatches({
        humanCreated,
        repositoryFullName,
        rule,
        snapshot: input.snapshot,
        task: input.task,
      })
    ) {
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
        author,
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

  if (prOwner.kind === 'inherit_author') {
    prOwner = {
      kind: 'inherit_author',
      userId: author.userId,
      displayName: author.displayName,
      githubLogin: author.githubLogin,
      reason: prOwner.reason,
      ruleId: prOwner.ruleId,
    };
  }

  return {
    effectiveAuthorKind: author.kind,
    effectiveAuthorUserId: author.userId,
    effectiveAuthorDisplayName: author.displayName,
    effectiveAuthorGithubLogin: author.githubLogin,
    effectiveAuthorGithubUserId: author.githubUserId,
    effectiveAuthorReason: author.reason,
    effectiveAuthorRuleId: author.ruleId,
    effectivePrOwnerKind: prOwner.kind,
    effectivePrOwnerUserId: prOwner.userId,
    effectivePrOwnerDisplayName: prOwner.displayName,
    effectivePrOwnerGithubLogin: prOwner.githubLogin,
    effectivePrOwnerReason: prOwner.reason,
    effectivePrOwnerRuleId: prOwner.ruleId,
  };
}
