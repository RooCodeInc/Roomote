import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  buildOpenCodeModelReasoningOptions,
  collectOpenRouterVariantModelAlias,
  GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME,
  getMcpIntegration,
  isInlineGoogleCredentialsValue,
  mergeOpenCodeModelReasoningOptions,
  mergeOpenRouterVariantAliasModels,
  normalizeOptionalReasoningEffort,
  renderManualSkillMarkdown,
  resolveOpenRouterVariantModelAlias,
  OPENCODE_ARCHITECT_AGENT,
  OPENCODE_AUTH_CONTENT_ENV_VAR_NAME,
  type EnvironmentManualSkill,
  type OpenRouterVariantModelAlias,
  type ReasoningEffort,
} from '@roomote/types';

import { SLACK_SILENCE_HOOK_SCRIPT } from './slack-silence-hook-script';
import { SLACK_POSTING_TOOL_EXCLUSIONS } from './slack-posting-tools';
import { SLACK_STOP_HOOK_SCRIPT } from './slack-stop-hook-script';
import { OPENCODE_SLACK_HOOKS_PLUGIN_SCRIPT } from './opencode-slack-hooks-plugin-script';
import { resolveOpenCodeModelSelection } from './opencode-model';
import {
  createProofRunnerAgentPrompt,
  createProofRunnerModelInstructions,
  ROOMOTE_OPENCODE_PROOF_RUNNER_AGENT_NAME,
} from './proof-runner-prompt';
import {
  getRepoLocalSkillInvocations,
  type RepoLocalSkill,
} from '../workspace/repo-local-skills';

const AGENTS_DIR_NAME = '.agents';

const PACKAGED_SKILLS_DIR_NAME = '.packaged-skills';

const RUNTIME_SKILLS_DIR_NAME = 'skills';

const STANDARD_PACKAGED_SKILLS_DIR_NAME = 'standard';

const OPENCODE_CONFIG_PARENT_DIR_NAME = '.config';

const OPENCODE_CONFIG_DIR_NAME = 'opencode';

const GOOGLE_APPLICATION_CREDENTIALS_FILE_NAME =
  'google-application-credentials.json';

export const OPENCODE_AUTH_FILE_NAME = 'auth.json';

const OPENROUTER_PROVIDER_ID = 'openrouter';

const BEDROCK_MANTLE_PROVIDER_ID = 'bedrock-mantle';

const DEFAULT_BEDROCK_MANTLE_REGION = 'us-east-1';

const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/u;

/**
 * OpenRouter identifies the calling application through the `HTTP-Referer`
 * and `X-Title` request headers rather than the standard `User-Agent`.
 * Setting them on the OpenRouter provider config ensures OpenRouter attributes
 * Roomote traffic to Roomote instead of OpenCode's default identity.
 */
const OPENCODE_OPENROUTER_ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://roomote.dev',
  'X-Title': 'Roomote',
} as const;

const ROOMOTE_OPENCODE_DEVELOPER_INSTRUCTIONS_FILE_NAME =
  'roomote-opencode-developer-instructions.md';

const ROOMOTE_OPENCODE_VISUAL_AGENT_NAME = 'visual';

const ROOMOTE_OPENCODE_JUDGE_AGENT_NAME = 'judge';

const ROOMOTE_OPENCODE_ADVISOR_AGENT_NAME = 'advisor';

const ROOMOTE_OPENCODE_EXPLORE_AGENT_NAME = 'explore';
const OPENCODE_GENERAL_AGENT_NAME = 'general';

const ROOMOTE_OPENCODE_VISUAL_MODEL_INSTRUCTIONS_FILE_NAME =
  'roomote-opencode-visual-model-instructions.md';

const ROOMOTE_OPENCODE_JUDGE_MODEL_INSTRUCTIONS_FILE_NAME =
  'roomote-opencode-judge-model-instructions.md';

const ROOMOTE_OPENCODE_ADVISOR_MODEL_INSTRUCTIONS_FILE_NAME =
  'roomote-opencode-advisor-model-instructions.md';

const ROOMOTE_OPENCODE_PROOF_RUNNER_INSTRUCTIONS_FILE_NAME =
  'roomote-opencode-proof-runner-instructions.md';

const ROOMOTE_OPENCODE_INTEGRATION_INSTRUCTIONS_FILE_NAME =
  'roomote-opencode-integration-instructions.md';

const ROOMOTE_OPENCODE_VISUAL_AGENT_PROMPT = [
  'You are Roomote visual information extraction support.',
  '',
  'Inspect image attachments, referenced image file paths, screenshots, diagrams, charts, rendered documents, and other visual artifacts. Return concise factual observations that the parent agent can use as evidence.',
  '',
  'Focus on visible text, UI state, layout, colors, charts, diagrams, and image details relevant to the parent request. If the visual evidence is ambiguous, state the uncertainty and what would disambiguate it.',
  '',
  'Do not edit files, run shell commands, launch other agents, or make final product decisions. Keep your response focused on extracted visual information.',
].join('\n');

const ROOMOTE_OPENCODE_JUDGE_AGENT_PROMPT = [
  'You are Roomote implementation review support.',
  '',
  'Compare the completed implementation against the parent task plan, checklist, or explicit requested outcome. Use any provided validation results as additional evidence.',
  '',
  'Start from the shipped diff, the stated plan, and the validation state. This is a completion and sanity check, not a broad codebase review.',
  '',
  'Keep tool use minimal and targeted. Prefer reviewing the supplied diff and only read additional files when needed to resolve a specific ambiguity or verify an obvious risk. Avoid open-ended repository exploration.',
  '',
  'Return concise review output with: 1) overall verdict, 2) what matches the plan, 3) gaps or regressions, 4) the smallest concrete follow-up fixes worth making now.',
  '',
  'Focus on request satisfaction, missing requirements, logic risks, edge cases, and mismatches between the plan and what was built. If the plan is incomplete or stale relative to the implementation, say so explicitly.',
  '',
  'Do not edit files, run shell commands, launch other agents, or make final product decisions. Keep your response focused on review findings and verdicts for the parent agent.',
].join('\n');

const ROOMOTE_OPENCODE_ADVISOR_AGENT_PROMPT = [
  'You are Roomote coding advisor support.',
  '',
  'The parent coding agent consults you when it is stuck or needs help: repeated or insurmountable failures to accomplish the task, a confusing bug, an uncertain approach or design decision, conflicting constraints, or when the user contradicts or challenges its approach, conclusion, or reasoning.',
  '',
  "Start from the context the parent provides: the goal, what was tried, exact errors or failing output, and the relevant files. When the consultation is about a user contradiction or challenge, start from the user's exact challenge and the parent's current reasoning. Read additional repository files when needed to ground your advice, but keep exploration targeted to the question.",
  '',
  'Return concrete, actionable guidance: 1) your diagnosis or best hypotheses, 2) the recommended approach and why, 3) specific next steps the parent can execute, 4) any risks or alternatives worth considering. Prefer a single clear recommendation over a menu of options. For user challenges, say whether the challenge is correct, partially correct, or mistaken, and what the parent should do next.',
  '',
  'If the provided context is insufficient to advise confidently, still write a short final answer that states the uncertainty and the exact evidence that would disambiguate the situation.',
  '',
  'Exit contract: always end with a non-empty final assistant message of plain-text advice for the parent. You may reason privately, but never finish a turn with only reasoning, tool calls, or whitespace. The parent receives only your final assistant text through the Task tool, so a reasoning-only completion is a failed consultation. Keep that final message self-contained and actionable.',
  '',
  'Do not edit files, run shell commands, launch other agents, or make final product decisions. Keep your response focused on advice the parent agent can act on.',
].join('\n');

const ROOMOTE_OPENCODE_ARCHITECT_AGENT_PROMPT = [
  'You are Roomote planning support: a planning specialist for read-mostly plan-mode turns.',
  '',
  'Keep repository-tracked files unchanged during planning turns. Use `/tmp` for scratch files, notes, and prototypes.',
  '',
  'Run whatever read, build, or test commands ground the plan in repository truth. Command execution is allowed; repository mutation and delivery actions are not.',
  '',
  'Publish finished plans as durable plan artifacts instead of leaving them chat-only.',
  '',
  'Exit contract: when the user explicitly asks you to implement, load the `implement-changes` skill with the skill tool in that same turn and close the turn briefly — the runtime automatically starts a writable continuation turn where you carry out the work. File edits in the current turn will still be denied; that is expected, not a permanent restriction. Never tell the user to start a new task.',
].join('\n');

export const ROOMOTE_OPENCODE_SLACK_STOP_HOOK_FILE_NAME =
  'roomote-opencode-slack-stop-hook.cjs';

const ROOMOTE_OPENCODE_SLACK_SILENCE_HOOK_FILE_NAME =
  'roomote-opencode-slack-silence-hook.cjs';

const ROOMOTE_OPENCODE_PLUGINS_DIR_NAME = 'plugins';

const ROOMOTE_OPENCODE_SLACK_HOOKS_PLUGIN_FILE_NAME = 'roomote-slack-hooks.js';

const OPENCODE_ALLOW_ALL_PERMISSION = {
  read: 'allow',
  edit: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  bash: 'allow',
  task: 'allow',
  external_directory: 'allow',
  todowrite: 'allow',
  todoread: 'allow',
  question: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  codesearch: 'allow',
  lsp: 'allow',
  skill: 'allow',
} as const;

const SKILLS_FOLDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolves which packaged skills directory should be used for a task.
 *
 * The built-in worker catalog is `standard`. If settings specify another
 * packaged skills folder, use it; otherwise use `standard`.
 */
export function resolvePackagedSkillsFolder({
  configuredSkillsFolder,
}: {
  configuredSkillsFolder?: string | null;
}): string {
  const normalizedConfiguredFolder = normalizePackagedFolderName(
    configuredSkillsFolder,
  );

  if (normalizedConfiguredFolder) {
    return normalizedConfiguredFolder;
  }

  return STANDARD_PACKAGED_SKILLS_DIR_NAME;
}

interface ActivateSkillsFolderOptions {
  homeDir: string;
  sourceHomeDir?: string;
  skillsFolderName: string;
  manualSkills?: EnvironmentManualSkill[];
  repoLocalSkills?: RepoLocalSkill[];
  /**
   * Packaged skill directory names to keep out of the task skill catalog.
   * Existing matching runtime entries are removed when present.
   */
  excludeSkillNames?: Iterable<string>;
}

function replaceMaterializedSkillEntry({
  sourcePath,
  destinationPath,
}: {
  sourcePath: string;
  destinationPath: string;
}): void {
  fs.rmSync(destinationPath, { recursive: true, force: true });
  fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
}

function restoreConfiguredManualSkills({
  manualSkills,
  targetSkillsDir,
  materializedSkillNames,
}: {
  manualSkills?: EnvironmentManualSkill[];
  targetSkillsDir: string;
  materializedSkillNames: Set<string>;
}): void {
  if (!manualSkills?.length) {
    return;
  }

  for (const manualSkill of manualSkills) {
    const skillName = manualSkill.name.trim();

    if (skillName.length === 0) {
      continue;
    }

    const destinationPath = path.join(targetSkillsDir, skillName);

    // Packaged skills stay authoritative on collisions.
    if (materializedSkillNames.has(skillName)) {
      continue;
    }

    fs.rmSync(destinationPath, { recursive: true, force: true });
    fs.mkdirSync(destinationPath, { recursive: true });

    fs.writeFileSync(
      path.join(destinationPath, 'SKILL.md'),
      renderManualSkillMarkdown(manualSkill),
      'utf8',
    );

    materializedSkillNames.add(skillName);
  }
}

function restoreRepoLocalSkills({
  repoLocalSkills,
  targetSkillsDir,
  materializedSkillNames,
}: {
  repoLocalSkills?: RepoLocalSkill[];
  targetSkillsDir: string;
  materializedSkillNames: Set<string>;
}): void {
  if (!repoLocalSkills?.length) {
    return;
  }

  for (const repoLocalSkillInvocation of getRepoLocalSkillInvocations(
    repoLocalSkills,
  )) {
    const skillName = repoLocalSkillInvocation.invocationName.trim();

    if (skillName.length === 0) {
      continue;
    }

    const destinationPath = path.join(targetSkillsDir, skillName);

    // Packaged and manual skills stay authoritative on collisions. When
    // multiple prepared repos expose the same bare skill name, only
    // repo-qualified aliases are materialized so cross-repo invocation stays
    // explicit instead of silently picking the first match.
    if (materializedSkillNames.has(skillName)) {
      continue;
    }

    fs.rmSync(destinationPath, { recursive: true, force: true });

    try {
      fs.symlinkSync(
        repoLocalSkillInvocation.repoLocalSkill.skillDirPath,
        destinationPath,
      );
    } catch {
      fs.cpSync(
        repoLocalSkillInvocation.repoLocalSkill.skillDirPath,
        destinationPath,
        {
          recursive: true,
          force: true,
        },
      );
    }

    materializedSkillNames.add(skillName);
  }
}

/**
 * Copies the contents of the selected packaged skills folder (for example
 * `standard`) from the worker-owned packaged-skills catalog into the task
 * runtime HOME, refreshes the currently-declared manual and repo-local
 * entries, and leaves unrelated existing runtime skills in place.
 *
 * Returns `true` when skills were activated, `false` otherwise.
 */
export function activateSkillsFolder({
  homeDir,
  sourceHomeDir,
  skillsFolderName,
  manualSkills,
  repoLocalSkills,
  excludeSkillNames,
}: ActivateSkillsFolderOptions): boolean {
  const normalizedName = normalizePackagedFolderName(skillsFolderName);

  if (!normalizedName) {
    return false;
  }

  const agentsDir = path.join(homeDir, AGENTS_DIR_NAME);
  const targetSkillsDir = path.join(agentsDir, RUNTIME_SKILLS_DIR_NAME);

  const sourceSkillsDir = path.join(
    sourceHomeDir ?? homeDir,
    PACKAGED_SKILLS_DIR_NAME,
    normalizedName,
  );

  if (!fs.existsSync(sourceSkillsDir)) {
    return false;
  }

  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(targetSkillsDir, { recursive: true });

  const sourceEntries = fs.readdirSync(sourceSkillsDir, {
    withFileTypes: true,
  });
  const excludedSkillNames = new Set(
    Array.from(excludeSkillNames ?? [], (skillName) => skillName.trim()).filter(
      Boolean,
    ),
  );
  const materializedSkillNames = new Set<string>();

  for (const entry of sourceEntries) {
    const destinationPath = path.join(targetSkillsDir, entry.name);

    if (excludedSkillNames.has(entry.name)) {
      fs.rmSync(destinationPath, { recursive: true, force: true });
      continue;
    }

    replaceMaterializedSkillEntry({
      sourcePath: path.join(sourceSkillsDir, entry.name),
      destinationPath,
    });
    materializedSkillNames.add(entry.name);
  }

  restoreConfiguredManualSkills({
    manualSkills,
    targetSkillsDir,
    materializedSkillNames,
  });
  restoreRepoLocalSkills({
    repoLocalSkills,
    targetSkillsDir,
    materializedSkillNames,
  });

  // Create .claude/skills/ with symlinks pointing back to .agents/skills/<name>.
  // Claude Code reads from .claude/skills/ while .agents/skills/ is the source of truth.
  const claudeSkillsDir = path.join(homeDir, '.claude', 'skills');
  fs.rmSync(claudeSkillsDir, { recursive: true, force: true });
  fs.mkdirSync(claudeSkillsDir, { recursive: true });

  const finalEntries = fs.readdirSync(targetSkillsDir, {
    withFileTypes: true,
  });

  for (const entry of finalEntries) {
    const agentsSkillPath = path.join(targetSkillsDir, entry.name);
    const claudeSkillPath = path.join(claudeSkillsDir, entry.name);

    try {
      fs.symlinkSync(agentsSkillPath, claudeSkillPath);
    } catch {
      fs.cpSync(agentsSkillPath, claudeSkillPath, {
        recursive: true,
        force: true,
      });
    }
  }

  return true;
}

interface GenerateOpenCodeConfigOptions {
  homeDir: string;
  runtimeEnv: Record<string, string>;
  developerInstructionsContent?: string;
  mcpServers?: OpenCodeConfigMcpServer[];
  model?: string;
  reasoningEffortOverride?: ReasoningEffort;
}

interface GenerateOpenCodeConfigResult {
  configContent: string;
  openCodeConfigDir: string;
  model?: string;
}

export interface OpenCodeRemoteMcpServerConfig {
  type: 'remote';
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface OpenCodeLocalMcpServerConfig {
  type: 'local';
  name: string;
  command: string;
  args?: string[];
  environment?: Record<string, string>;
}

export type OpenCodeConfigMcpServer =
  | OpenCodeRemoteMcpServerConfig
  | OpenCodeLocalMcpServerConfig;

/**
 * Composes agent-facing usage guidance for attached built-in MCP integrations.
 * Integration catalog entries can declare `instructions` describing when the
 * agent should reach for their tools; when such an integration's MCP server is
 * attached to the task, that guidance is injected as an instruction file so
 * usage does not depend on tool descriptions alone.
 */
function createIntegrationMcpInstructions(
  mcpServers: OpenCodeConfigMcpServer[] | undefined,
): string | undefined {
  const sections = (mcpServers ?? []).flatMap((mcpServer) => {
    const integration = getMcpIntegration(mcpServer.name);

    if (!integration) {
      return [];
    }

    const instructions = integration.instructions?.trim();

    if (!instructions) {
      return [];
    }

    return [`# Connected integration: ${integration.name}\n\n${instructions}`];
  });

  if (sections.length === 0) {
    return undefined;
  }

  return `${sections.join('\n\n')}\n`;
}

function createOpenCodeMcpConfig(
  mcpServers: OpenCodeConfigMcpServer[] | undefined,
): Record<string, unknown> | undefined {
  if (!mcpServers?.length) {
    return undefined;
  }

  return Object.fromEntries(
    mcpServers.map((mcpServer) => {
      if (mcpServer.type === 'local') {
        return [
          mcpServer.name,
          {
            type: 'local',
            command: [mcpServer.command, ...(mcpServer.args ?? [])],
            enabled: true,
            ...(mcpServer.environment
              ? { environment: mcpServer.environment }
              : {}),
          },
        ];
      }

      return [
        mcpServer.name,
        {
          type: 'remote',
          url: mcpServer.url,
          enabled: true,
          oauth: false,
          ...(mcpServer.headers ? { headers: mcpServer.headers } : {}),
        },
      ];
    }),
  );
}

function writeOpenCodeSlackHookFiles(openCodeConfigDir: string): void {
  const pluginsDir = path.join(
    openCodeConfigDir,
    ROOMOTE_OPENCODE_PLUGINS_DIR_NAME,
  );
  const pluginPath = path.join(
    pluginsDir,
    ROOMOTE_OPENCODE_SLACK_HOOKS_PLUGIN_FILE_NAME,
  );
  const silenceHookPath = path.join(
    openCodeConfigDir,
    ROOMOTE_OPENCODE_SLACK_SILENCE_HOOK_FILE_NAME,
  );
  const stopHookPath = path.join(
    openCodeConfigDir,
    ROOMOTE_OPENCODE_SLACK_STOP_HOOK_FILE_NAME,
  );

  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(pluginPath, OPENCODE_SLACK_HOOKS_PLUGIN_SCRIPT, 'utf8');
  fs.writeFileSync(silenceHookPath, SLACK_SILENCE_HOOK_SCRIPT, 'utf8');
  fs.writeFileSync(stopHookPath, SLACK_STOP_HOOK_SCRIPT, 'utf8');
  fs.chmodSync(silenceHookPath, 0o755);
  fs.chmodSync(stopHookPath, 0o755);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function mergeBedrockMantleProviderConfig(
  providerConfig: Record<string, unknown>,
  runtimeEnv: Record<string, string>,
  modelIds: Array<string | undefined>,
): Record<string, unknown> {
  const mantleModelIds = [
    ...new Set(
      modelIds.flatMap((modelId) => {
        const prefix = `${BEDROCK_MANTLE_PROVIDER_ID}/`;
        const normalized = modelId?.trim();

        return normalized?.startsWith(prefix)
          ? [normalized.slice(prefix.length)]
          : [];
      }),
    ),
  ];

  if (mantleModelIds.length === 0) {
    return providerConfig;
  }

  const region = runtimeEnv.AWS_REGION?.trim() || DEFAULT_BEDROCK_MANTLE_REGION;

  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error(
      `AWS_REGION must be a valid AWS region for Amazon Bedrock. Received "${region}".`,
    );
  }

  const existingProvider = asRecord(providerConfig[BEDROCK_MANTLE_PROVIDER_ID]);
  const existingOptions = asRecord(existingProvider.options);
  const existingModels = asRecord(existingProvider.models);
  const models = Object.fromEntries(
    mantleModelIds.map((modelId) => [
      modelId,
      {
        name: modelId,
        ...asRecord(existingModels[modelId]),
      },
    ]),
  );

  return {
    ...providerConfig,
    [BEDROCK_MANTLE_PROVIDER_ID]: {
      ...existingProvider,
      npm: '@ai-sdk/anthropic',
      name: 'Amazon Bedrock',
      options: {
        ...existingOptions,
        baseURL: `https://bedrock-mantle.${region}.api.aws/anthropic/v1`,
        apiKey: '{env:AWS_BEARER_TOKEN_BEDROCK}',
      },
      models: {
        ...existingModels,
        ...models,
      },
    },
  };
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }

  return [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function writeGlobalOpenCodeConfig(
  openCodeConfigDir: string,
  value: string,
): void {
  const globalConfigPath = path.join(openCodeConfigDir, 'opencode.json');

  fs.mkdirSync(openCodeConfigDir, { recursive: true });
  fs.writeFileSync(globalConfigPath, `${value.trim()}\n`, 'utf8');
}

function validateRoomoteModelEnv(name: string, value: string): void {
  try {
    resolveOpenCodeModelSelection(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    throw new Error(
      `${name} must use provider/model format. Received "${value}". ${detail}`,
    );
  }
}

function createVisualAgentConfig(
  model: string,
  reasoningOptions?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    description:
      'Extracts factual information from images, screenshots, diagrams, charts, rendered documents, and other visual artifacts.',
    mode: 'subagent',
    hidden: true,
    model,
    ...(reasoningOptions ? { options: reasoningOptions } : {}),
    prompt: ROOMOTE_OPENCODE_VISUAL_AGENT_PROMPT,
    permission: {
      read: 'allow',
      list: 'allow',
      glob: 'allow',
      grep: 'allow',
      webfetch: 'allow',
      external_directory: 'allow',
      edit: 'deny',
      bash: 'deny',
      task: 'deny',
      todowrite: 'deny',
      lsp: 'deny',
      skill: 'deny',
      question: 'deny',
    },
    tools: { ...SLACK_POSTING_TOOL_EXCLUSIONS },
  };
}

function createJudgeAgentConfig(
  model: string,
  reasoningOptions?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    description:
      'Compares completed implementation against a plan or requested outcome and returns concise review findings.',
    mode: 'subagent',
    hidden: true,
    model,
    ...(reasoningOptions ? { options: reasoningOptions } : {}),
    prompt: ROOMOTE_OPENCODE_JUDGE_AGENT_PROMPT,
    permission: {
      read: 'allow',
      list: 'allow',
      glob: 'allow',
      grep: 'allow',
      external_directory: 'allow',
      webfetch: 'deny',
      edit: 'deny',
      bash: 'deny',
      task: 'deny',
      todowrite: 'deny',
      lsp: 'deny',
      skill: 'deny',
      question: 'deny',
    },
    tools: { ...SLACK_POSTING_TOOL_EXCLUSIONS },
  };
}

function createAdvisorAgentConfig(
  model: string,
  reasoningOptions?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    description:
      'Consulting advisor the coding agent can ask for help when it is stuck, hits repeated or insurmountable task failures, needs a second opinion on approach or debugging, or the user contradicts or challenges it.',
    mode: 'subagent',
    model,
    ...(reasoningOptions ? { options: reasoningOptions } : {}),
    prompt: ROOMOTE_OPENCODE_ADVISOR_AGENT_PROMPT,
    permission: {
      read: 'allow',
      list: 'allow',
      glob: 'allow',
      grep: 'allow',
      external_directory: 'allow',
      webfetch: 'allow',
      edit: 'deny',
      bash: 'deny',
      task: 'deny',
      todowrite: 'deny',
      lsp: 'deny',
      skill: 'deny',
      question: 'deny',
    },
    tools: { ...SLACK_POSTING_TOOL_EXCLUSIONS },
  };
}

// Note: the architect agent deliberately keeps the Slack-posting tools. It is
// a primary (parent-session) agent that owns plan-mode turns end to end, so
// it must be able to reply to the originating Slack thread itself.
function createArchitectAgentConfig(options: {
  model?: string;
  reasoningOptions?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    description:
      'Roomote planning specialist that runs read-mostly plan-mode turns without changing repository-tracked files.',
    mode: 'primary',
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningOptions ? { options: options.reasoningOptions } : {}),
    prompt: ROOMOTE_OPENCODE_ARCHITECT_AGENT_PROMPT,
    permission: {
      read: 'allow',
      list: 'allow',
      glob: 'allow',
      grep: 'allow',
      external_directory: 'allow',
      webfetch: 'allow',
      lsp: 'allow',
      todowrite: 'allow',
      question: 'allow',
      skill: 'allow',
      task: 'allow',
      // `edit: deny` is the single hard guard for plan-mode turns; bash stays
      // fully allowed and repo-mutation/delivery discipline is prompt-governed
      // (documented tradeoff).
      bash: 'allow',
      edit: 'deny',
    },
  };
}

function createProofRunnerAgentConfig(
  browserTarget: string,
): Record<string, unknown> {
  return {
    description:
      'Delegated browser proof runner that captures and uploads screenshot and screencast proof from the sandbox-local browser surface.',
    mode: 'subagent',
    hidden: true,
    prompt: createProofRunnerAgentPrompt(browserTarget),
    permission: {
      read: 'allow',
      list: 'allow',
      glob: 'allow',
      grep: 'allow',
      bash: 'allow',
      external_directory: 'allow',
      edit: 'deny',
      task: 'deny',
      todowrite: 'deny',
      webfetch: 'deny',
      lsp: 'deny',
      skill: 'allow',
      question: 'deny',
    },
    // The runner's only sanctioned MCP surface is artifact upload. Without
    // this map it inherits the session's full roomote MCP toolset, including
    // outward-facing writes (manage_source_control, send_chat_reply).
    // Explicit per-tool denies rather than a wildcard: a mismatched name then
    // fails toward the tool staying enabled instead of breaking uploads.
    tools: {
      ...SLACK_POSTING_TOOL_EXCLUSIONS,
      roomote_get_about_me: false,
      roomote_describe_video: false,
      roomote_manage_tasks: false,
      roomote_manage_source_control: false,
      roomote_manage_environments: false,
      roomote_request_environment_variables: false,
      roomote_report_platform_issue: false,
      roomote_get_slack_channel_messages: false,
      roomote_get_slack_thread: false,
      roomote_add_reaction_to_slack_message: false,
    },
  };
}

function createVisualModelInstructions(): string {
  return [
    `A hidden OpenCode \`${ROOMOTE_OPENCODE_VISUAL_AGENT_NAME}\` subagent is configured with Roomote's deployment vision model.`,
    '',
    `When the task requires extracting information from screenshots, diagrams, charts, rendered documents, UI captures, or other visual attachments, delegate that visual inspection to the \`${ROOMOTE_OPENCODE_VISUAL_AGENT_NAME}\` subagent with the Task tool. Treat its response as visual evidence for the parent task.`,
    '',
    'If the current user prompt includes an image attachment or a referenced image file path and your active coding model cannot inspect images directly, do not tell the user you cannot view images. Use the visual subagent to inspect the image, then continue the parent task from its observations.',
    '',
    'Keep orchestration, implementation, and final user-facing decisions in the parent agent. Ask the visual subagent targeted follow-up questions when the visual evidence is incomplete or ambiguous.',
  ].join('\n');
}

function createJudgeModelInstructions(): string {
  return [
    `A hidden OpenCode \`${ROOMOTE_OPENCODE_JUDGE_AGENT_NAME}\` subagent is always configured for implementation review support.`,
    '',
    'When `R_CODE_REVIEW_MODEL` is configured, the judge uses that review model. Otherwise it falls back to the active coding model for the task.',
    '',
    `After implementation and validation, when the task has a concrete plan, checklist, or explicit requested outcome to compare against, delegate one focused compare pass to the \`${ROOMOTE_OPENCODE_JUDGE_AGENT_NAME}\` subagent with the Task tool.`,
    '',
    'Treat the judge as a narrow completion and sanity check. Start from the shipped diff, the plan, and the validation state instead of asking for an open-ended repo review.',
    '',
    'Keep judge tool use minimal and targeted. Prefer the supplied diff, and only read extra files to resolve a specific ambiguity or verify an obvious risk.',
    '',
    'Ask it to review what was built against the plan or requested outcome, summarize what matches, call out missing or risky gaps, and return the smallest concrete follow-up fixes worth making now.',
    '',
    'Treat the judge response as review input for the parent workflow. Keep orchestration, code changes, and final user-facing decisions in the parent agent.',
    '',
    "Do not paste the judge's full output into chat or any user-facing reply. The judge verdict is internal review material; surface at most a brief, parent-authored summary of the actionable outcome (what was fixed or what still needs attention), never the raw review dump.",
  ].join('\n');
}

function createAdvisorModelInstructions(): string {
  return [
    `An OpenCode \`${ROOMOTE_OPENCODE_ADVISOR_AGENT_NAME}\` subagent is always configured as consulting support for the active coding agent.`,
    '',
    'When `R_PLANNING_MODEL` is configured, the advisor uses that advisor model. Otherwise it falls back to the active coding model, running at the advisor reasoning level (defaults to high) for deeper analysis.',
    '',
    `When you are stuck or need help — repeated failed fix attempts, a confusing bug, an uncertain approach or design decision, or conflicting constraints — delegate one focused consultation to the \`${ROOMOTE_OPENCODE_ADVISOR_AGENT_NAME}\` subagent with the Task tool before grinding through more blind attempts.`,
    '',
    `If you hit repeated or insurmountable failures to accomplish the task — including blockers you cannot clear after serious attempts, dead ends that keep recurring, or approach failures that make progress look unlikely — delegate one focused consultation to the \`${ROOMOTE_OPENCODE_ADVISOR_AGENT_NAME}\` subagent with the Task tool before more of the same failing approach. Include what failed, what you tried, and why it continues to fail.`,
    '',
    `If the user contradicts or challenges your approach, conclusion, or reasoning, delegate one focused consultation to the \`${ROOMOTE_OPENCODE_ADVISOR_AGENT_NAME}\` subagent with the Task tool before doubling down, arguing back, or overriding the challenge. Include the user's exact challenge and your current reasoning in the brief, then take the advisor's assessment seriously while still verifying against the repository.`,
    '',
    'Give the advisor a complete brief: the goal, what you already tried, the exact errors or failing output, and the relevant file paths. When the user has contradicted or challenged you, include their exact challenge and your current reasoning. The advisor can read the repository but cannot run commands, so include runtime evidence it cannot gather itself. Explicitly ask for a short final-text answer; only that final assistant text is returned by the Task tool.',
    '',
    'If the advisor Task tool returns empty or whitespace-only output, treat that as a failed consultation with no signal. Do not invent what the advisor would have said. Retry at most once with a tighter brief that requires a short final-text answer and no tools if enough evidence is already in the brief; otherwise continue from your own repository evidence.',
    '',
    'Treat the advisor response as internal guidance for the parent workflow. Verify its recommendations against the repository before acting on them, and keep orchestration, code changes, and final user-facing decisions in the parent agent.',
    '',
    "Do not paste the advisor's full output into chat or any user-facing reply. Surface at most a brief, parent-authored summary of the direction taken.",
  ].join('\n');
}

function createExploreAgentConfig(options: {
  model: string;
  reasoningOptions?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    model: options.model,
    ...(options.reasoningOptions ? { options: options.reasoningOptions } : {}),
    // Redundant with the built-in explore agent's wildcard-deny permission
    // set, but kept explicit so every generated subagent override carries the
    // Slack-posting exclusions.
    tools: { ...SLACK_POSTING_TOOL_EXCLUSIONS },
  };
}

function resolveModelBackedOpenCodeConfig(
  runtimeEnv: Record<string, string>,
  modelOverride?: string,
  reasoningEffortOverride?: ReasoningEffort,
): Record<string, unknown> | null {
  const rawModel = runtimeEnv.R_MODEL?.trim();

  if (!rawModel) {
    return null;
  }

  const rawSmallModel = runtimeEnv.R_SMALL_MODEL?.trim();
  const rawVisionModel = runtimeEnv.R_VISION_MODEL?.trim();
  const rawCodeReviewModel = runtimeEnv.R_CODE_REVIEW_MODEL?.trim();
  const rawExploreModel = runtimeEnv.R_EXPLORE_MODEL?.trim();
  const rawPlanningModel = runtimeEnv.R_PLANNING_MODEL?.trim();
  const modelReasoningEffort = normalizeOptionalReasoningEffort(
    runtimeEnv.R_MODEL_REASONING_EFFORT?.trim(),
  );
  const smallModelReasoningEffort = normalizeOptionalReasoningEffort(
    runtimeEnv.R_SMALL_MODEL_REASONING_EFFORT?.trim(),
  );
  const visionModelReasoningEffort = normalizeOptionalReasoningEffort(
    runtimeEnv.R_VISION_MODEL_REASONING_EFFORT?.trim(),
  );
  const codeReviewModelReasoningEffort = normalizeOptionalReasoningEffort(
    runtimeEnv.R_CODE_REVIEW_MODEL_REASONING_EFFORT?.trim(),
  );
  const exploreModelReasoningEffort = normalizeOptionalReasoningEffort(
    runtimeEnv.R_EXPLORE_MODEL_REASONING_EFFORT?.trim(),
  );
  const planningModelReasoningEffort = normalizeOptionalReasoningEffort(
    runtimeEnv.R_PLANNING_MODEL_REASONING_EFFORT?.trim(),
  );
  validateRoomoteModelEnv('R_MODEL', rawModel);

  if (rawSmallModel) {
    validateRoomoteModelEnv('R_SMALL_MODEL', rawSmallModel);
  }

  if (rawVisionModel) {
    validateRoomoteModelEnv('R_VISION_MODEL', rawVisionModel);
  }

  if (rawCodeReviewModel) {
    validateRoomoteModelEnv('R_CODE_REVIEW_MODEL', rawCodeReviewModel);
  }

  if (rawExploreModel) {
    validateRoomoteModelEnv('R_EXPLORE_MODEL', rawExploreModel);
  }

  if (rawPlanningModel) {
    validateRoomoteModelEnv('R_PLANNING_MODEL', rawPlanningModel);
  }

  // OpenRouter variant models (`:nitro`, `:free`, ...) are rewritten to their
  // catalog base model for every role and mapped back to the variant through
  // provider model aliases below, because OpenCode rejects model IDs its
  // catalog does not contain. Collection order is precedence order: when
  // roles disagree on the variant of a shared base model, the per-task
  // override wins, then the coding model, then helper roles.
  const variantAliases = new Map<string, OpenRouterVariantModelAlias>();
  const normalizedModelOverride = modelOverride
    ? collectOpenRouterVariantModelAlias(variantAliases, modelOverride)
    : undefined;
  const model = collectOpenRouterVariantModelAlias(variantAliases, rawModel);
  const smallModel = rawSmallModel
    ? collectOpenRouterVariantModelAlias(variantAliases, rawSmallModel)
    : undefined;
  const visionModel = rawVisionModel
    ? collectOpenRouterVariantModelAlias(variantAliases, rawVisionModel)
    : undefined;
  const codeReviewModel = rawCodeReviewModel
    ? collectOpenRouterVariantModelAlias(variantAliases, rawCodeReviewModel)
    : undefined;
  const exploreModel = rawExploreModel
    ? collectOpenRouterVariantModelAlias(variantAliases, rawExploreModel)
    : undefined;
  const planningModel = rawPlanningModel
    ? collectOpenRouterVariantModelAlias(variantAliases, rawPlanningModel)
    : undefined;
  const effectiveCodingModel = normalizedModelOverride ?? model;

  delete runtimeEnv.R_MODEL;
  delete runtimeEnv.R_SMALL_MODEL;
  delete runtimeEnv.R_VISION_MODEL;
  delete runtimeEnv.R_CODE_REVIEW_MODEL;
  delete runtimeEnv.R_EXPLORE_MODEL;
  delete runtimeEnv.R_PLANNING_MODEL;
  delete runtimeEnv.R_MODEL_REASONING_EFFORT;
  delete runtimeEnv.R_SMALL_MODEL_REASONING_EFFORT;
  delete runtimeEnv.R_VISION_MODEL_REASONING_EFFORT;
  delete runtimeEnv.R_CODE_REVIEW_MODEL_REASONING_EFFORT;
  delete runtimeEnv.R_EXPLORE_MODEL_REASONING_EFFORT;
  delete runtimeEnv.R_PLANNING_MODEL_REASONING_EFFORT;
  delete runtimeEnv.R_MODEL_ENV_KEYS;

  const visualAgent =
    visionModel && visionModel !== effectiveCodingModel
      ? {
          [ROOMOTE_OPENCODE_VISUAL_AGENT_NAME]: createVisualAgentConfig(
            visionModel,
            visionModelReasoningEffort
              ? buildOpenCodeModelReasoningOptions(
                  visionModel,
                  visionModelReasoningEffort,
                )
              : null,
          ),
        }
      : undefined;
  const judgeModel = codeReviewModel ?? effectiveCodingModel;
  const judgeAgent = {
    [ROOMOTE_OPENCODE_JUDGE_AGENT_NAME]: createJudgeAgentConfig(
      judgeModel,
      codeReviewModel && codeReviewModelReasoningEffort
        ? buildOpenCodeModelReasoningOptions(
            codeReviewModel,
            codeReviewModelReasoningEffort,
          )
        : null,
    ),
  };
  // The advisor subagent shares the planning/advisor model role. It defaults
  // to the coding model when no advisor model is configured, and the advisor
  // reasoning level (default high) applies in either case so consultations
  // run with deeper reasoning than ordinary coding turns.
  const advisorModel = planningModel ?? effectiveCodingModel;
  const advisorAgent = {
    [ROOMOTE_OPENCODE_ADVISOR_AGENT_NAME]: createAdvisorAgentConfig(
      advisorModel,
      planningModelReasoningEffort
        ? buildOpenCodeModelReasoningOptions(
            advisorModel,
            planningModelReasoningEffort,
          )
        : null,
    ),
  };
  const exploreEffectiveModel = exploreModel ?? effectiveCodingModel;
  const exploreAgent =
    exploreModel || exploreModelReasoningEffort
      ? {
          [ROOMOTE_OPENCODE_EXPLORE_AGENT_NAME]: createExploreAgentConfig({
            model: exploreEffectiveModel,
            reasoningOptions: exploreModelReasoningEffort
              ? buildOpenCodeModelReasoningOptions(
                  exploreEffectiveModel,
                  exploreModelReasoningEffort,
                )
              : null,
          }),
        }
      : undefined;
  // Plan-mode turns run on Roomote's own `architect` primary agent instead of
  // OpenCode's built-in `plan` agent, so it is registered unconditionally.
  // When a planning model is configured, the agent-level model applies;
  // otherwise architect turns inherit the config's top-level model. The
  // planning reasoning level still applies in either case through the
  // agent-level options.
  const architectAgent = {
    [OPENCODE_ARCHITECT_AGENT]: createArchitectAgentConfig({
      model: planningModel,
      reasoningOptions: planningModelReasoningEffort
        ? buildOpenCodeModelReasoningOptions(
            planningModel ?? effectiveCodingModel,
            planningModelReasoningEffort,
          )
        : null,
    }),
  };
  // OpenCode's built-in `general` agent is the default subagent type for
  // background Task launches. A named config entry for a built-in agent
  // merges onto it in place (OpenCode applies provided fields and merges the
  // tools/permission rules over the built-in ruleset) rather than redefining
  // it as a custom agent, so this only strips the Slack-posting tools.
  const generalAgent = {
    [OPENCODE_GENERAL_AGENT_NAME]: {
      tools: { ...SLACK_POSTING_TOOL_EXCLUSIONS },
    },
  };
  const agent = {
    ...(visualAgent ?? {}),
    ...judgeAgent,
    ...advisorAgent,
    ...(exploreAgent ?? {}),
    ...architectAgent,
    ...generalAgent,
  };

  // Reasoning levels are configured per default-model role, so a level is only
  // applied when the model in play is the one the role was configured with.
  // Role precedence for a shared model: effective coding model first, then the
  // persisted coding model, then a distinct helper model. The vision level is
  // scoped to the visual subagent via agent-level options above. A per-task
  // reasoning effort (stamped at launch for model overrides, or set
  // explicitly via the public API) wins over the role-configured levels.
  const effectiveCodingModelReasoningEffort: ReasoningEffort | null =
    reasoningEffortOverride ??
    (effectiveCodingModel === model
      ? modelReasoningEffort
      : codeReviewModel && effectiveCodingModel === codeReviewModel
        ? codeReviewModelReasoningEffort
        : null);
  let providerReasoningConfig: Record<string, unknown> = {};

  if (effectiveCodingModelReasoningEffort) {
    providerReasoningConfig = mergeOpenCodeModelReasoningOptions(
      providerReasoningConfig,
      effectiveCodingModel,
      effectiveCodingModelReasoningEffort,
    );
  }

  if (modelReasoningEffort) {
    providerReasoningConfig = mergeOpenCodeModelReasoningOptions(
      providerReasoningConfig,
      model,
      modelReasoningEffort,
    );
  }

  if (
    smallModel &&
    smallModelReasoningEffort &&
    smallModel !== model &&
    smallModel !== effectiveCodingModel
  ) {
    providerReasoningConfig = mergeOpenCodeModelReasoningOptions(
      providerReasoningConfig,
      smallModel,
      smallModelReasoningEffort,
    );
  }

  const providerConfig = mergeBedrockMantleProviderConfig(
    mergeOpenRouterVariantAliasModels(providerReasoningConfig, variantAliases),
    runtimeEnv,
    [
      effectiveCodingModel,
      model,
      smallModel,
      visionModel,
      codeReviewModel,
      exploreModel,
      planningModel,
    ],
  );

  return {
    model,
    small_model: smallModel ?? model,
    agent,
    ...(Object.keys(providerConfig).length > 0
      ? { provider: providerConfig }
      : {}),
  };
}

function loadOperatorOpenCodeConfig({
  runtimeEnv,
  openCodeConfigDir,
  modelOverride,
  reasoningEffortOverride,
}: {
  runtimeEnv: Record<string, string>;
  openCodeConfigDir: string;
  modelOverride?: string;
  reasoningEffortOverride?: ReasoningEffort;
}): Record<string, unknown> {
  const modelConfig = resolveModelBackedOpenCodeConfig(
    runtimeEnv,
    modelOverride,
    reasoningEffortOverride,
  );

  if (modelConfig) {
    writeGlobalOpenCodeConfig(
      openCodeConfigDir,
      JSON.stringify(modelConfig, null, 2),
    );

    return modelConfig;
  }

  throw new Error(
    'Model configuration is required. Set R_MODEL to a provider/model ID. Set R_SMALL_MODEL when routing and title generation should use a different small model.',
  );
}

function resolveConfiguredPromptModel(model?: string): string | undefined {
  const resolvedModel = model?.trim();

  if (!resolvedModel) {
    return undefined;
  }

  resolveOpenCodeModelSelection(resolvedModel);
  return resolvedModel;
}

/**
 * Merges operator-provided provider config with Roomote's OpenRouter
 * attribution headers. Roomote's headers take precedence so OpenRouter
 * always attributes traffic to Roomote, while operator provider config
 * (custom base URLs, models, etc.) is preserved.
 */
function resolveOpenCodeProviderConfig(
  operatorProvider: Record<string, unknown>,
): Record<string, unknown> {
  const openRouterOperatorConfig = asRecord(
    operatorProvider[OPENROUTER_PROVIDER_ID],
  );
  const openRouterOperatorOptions = asRecord(openRouterOperatorConfig.options);
  const openRouterOperatorHeaders = asRecord(openRouterOperatorOptions.headers);

  return {
    ...operatorProvider,
    [OPENROUTER_PROVIDER_ID]: {
      ...openRouterOperatorConfig,
      options: {
        ...openRouterOperatorOptions,
        headers: {
          ...openRouterOperatorHeaders,
          ...OPENCODE_OPENROUTER_ATTRIBUTION_HEADERS,
        },
      },
    },
  };
}

/**
 * Generates Roomote's per-task OpenCode inline config overlay. Deployment
 * model env vars are materialized into OpenCode's global config under the
 * sandbox HOME. Roomote adds runtime overrides through the generated
 * `OPENCODE_CONFIG_CONTENT` passed directly to the harness process.
 */
export function generateOpenCodeConfig({
  homeDir,
  runtimeEnv,
  developerInstructionsContent,
  mcpServers,
  model,
  reasoningEffortOverride,
}: GenerateOpenCodeConfigOptions): GenerateOpenCodeConfigResult {
  const openCodeConfigDir = path.join(
    homeDir,
    OPENCODE_CONFIG_PARENT_DIR_NAME,
    OPENCODE_CONFIG_DIR_NAME,
  );
  fs.mkdirSync(openCodeConfigDir, { recursive: true });
  materializeInlineGoogleCredentials(runtimeEnv, homeDir);
  const resolvedModel = resolveConfiguredPromptModel(model);
  // A variant task model (`openrouter/...:nitro`) surfaces as its catalog base
  // model here (inline config + per-prompt model selection); the operator
  // config records the provider alias that carries the variant to OpenRouter.
  const promptModel = resolvedModel
    ? (resolveOpenRouterVariantModelAlias(resolvedModel)?.baseModel ??
      resolvedModel)
    : undefined;
  const operatorConfig = loadOperatorOpenCodeConfig({
    runtimeEnv,
    openCodeConfigDir,
    modelOverride: resolvedModel,
    reasoningEffortOverride,
  });
  const instructions: string[] = [];

  writeOpenCodeSlackHookFiles(openCodeConfigDir);

  if (developerInstructionsContent) {
    const developerInstructionsPath = path.join(
      openCodeConfigDir,
      ROOMOTE_OPENCODE_DEVELOPER_INSTRUCTIONS_FILE_NAME,
    );
    fs.writeFileSync(
      developerInstructionsPath,
      developerInstructionsContent,
      'utf8',
    );
    instructions.push(developerInstructionsPath);
  }

  const operatorAgent = asRecord(operatorConfig.agent);
  if (operatorAgent[ROOMOTE_OPENCODE_VISUAL_AGENT_NAME]) {
    const visualModelInstructionsPath = path.join(
      openCodeConfigDir,
      ROOMOTE_OPENCODE_VISUAL_MODEL_INSTRUCTIONS_FILE_NAME,
    );
    fs.writeFileSync(
      visualModelInstructionsPath,
      createVisualModelInstructions(),
      'utf8',
    );
    instructions.push(visualModelInstructionsPath);
  }

  if (operatorAgent[ROOMOTE_OPENCODE_JUDGE_AGENT_NAME]) {
    const judgeModelInstructionsPath = path.join(
      openCodeConfigDir,
      ROOMOTE_OPENCODE_JUDGE_MODEL_INSTRUCTIONS_FILE_NAME,
    );
    fs.writeFileSync(
      judgeModelInstructionsPath,
      createJudgeModelInstructions(),
      'utf8',
    );
    instructions.push(judgeModelInstructionsPath);
  }

  if (operatorAgent[ROOMOTE_OPENCODE_ADVISOR_AGENT_NAME]) {
    const advisorModelInstructionsPath = path.join(
      openCodeConfigDir,
      ROOMOTE_OPENCODE_ADVISOR_MODEL_INSTRUCTIONS_FILE_NAME,
    );
    fs.writeFileSync(
      advisorModelInstructionsPath,
      createAdvisorModelInstructions(),
      'utf8',
    );
    instructions.push(advisorModelInstructionsPath);
  }

  const proofBrowserTarget = runtimeEnv.ROOMOTE_PROOF_BROWSER_TARGET?.trim();
  delete runtimeEnv.ROOMOTE_PROOF_BROWSER_TARGET;

  if (proofBrowserTarget) {
    operatorAgent[ROOMOTE_OPENCODE_PROOF_RUNNER_AGENT_NAME] =
      createProofRunnerAgentConfig(proofBrowserTarget);

    const proofRunnerInstructionsPath = path.join(
      openCodeConfigDir,
      ROOMOTE_OPENCODE_PROOF_RUNNER_INSTRUCTIONS_FILE_NAME,
    );
    fs.writeFileSync(
      proofRunnerInstructionsPath,
      createProofRunnerModelInstructions(proofBrowserTarget),
      'utf8',
    );
    instructions.push(proofRunnerInstructionsPath);
  }

  const integrationInstructionsContent =
    createIntegrationMcpInstructions(mcpServers);

  if (integrationInstructionsContent) {
    const integrationInstructionsPath = path.join(
      openCodeConfigDir,
      ROOMOTE_OPENCODE_INTEGRATION_INSTRUCTIONS_FILE_NAME,
    );
    fs.writeFileSync(
      integrationInstructionsPath,
      integrationInstructionsContent,
      'utf8',
    );
    instructions.push(integrationInstructionsPath);
  }

  const mcpConfig = createOpenCodeMcpConfig(mcpServers);
  const operatorSkills = asRecord(operatorConfig.skills);
  const operatorPermission = asRecord(operatorConfig.permission);
  const operatorMcp = asRecord(operatorConfig.mcp);
  const operatorProvider = resolveOpenCodeProviderConfig(
    asRecord(operatorConfig.provider),
  );
  const operatorSmallModel =
    typeof operatorConfig.small_model === 'string'
      ? operatorConfig.small_model
      : undefined;
  const config = {
    share: 'disabled',
    autoupdate: false,
    ...(promptModel
      ? {
          model: promptModel,
          small_model: operatorSmallModel ?? promptModel,
        }
      : {}),
    permission: {
      ...operatorPermission,
      ...OPENCODE_ALLOW_ALL_PERMISSION,
    },
    provider: operatorProvider,
    skills: {
      ...operatorSkills,
      paths: uniqueStrings([
        ...normalizeStringList(operatorSkills.paths),
        path.join(homeDir, AGENTS_DIR_NAME, RUNTIME_SKILLS_DIR_NAME),
      ]),
    },
    instructions: uniqueStrings([
      ...normalizeStringList(operatorConfig.instructions),
      ...instructions,
    ]),
    ...(Object.keys(operatorAgent).length > 0 ? { agent: operatorAgent } : {}),
    ...(mcpConfig ? { mcp: { ...operatorMcp, ...mcpConfig } } : {}),
  };

  return {
    configContent: `${JSON.stringify(config, null, 2)}\n`,
    openCodeConfigDir,
    model: promptModel,
  };
}

/**
 * Resolve the OpenCode data directory shared by credential files, auth state,
 * and runtime shell overlays.
 */
export function resolveOpenCodeDataDir(
  homeDir: string,
  runtimeEnv: Record<string, string | undefined>,
): string {
  const xdgDataHome = runtimeEnv.XDG_DATA_HOME?.trim();

  return path.join(
    xdgDataHome || path.join(homeDir, '.local', 'share'),
    OPENCODE_CONFIG_DIR_NAME,
  );
}

/**
 * Credential files materialized under the OpenCode data dir for a run: the
 * ChatGPT subscription `auth.json` and the inline Google service-account
 * JSON. Deleted before filesystem snapshots; both are re-materialized from
 * the dequeue/resume env at the next run start.
 */
export function resolveOpenCodeCredentialFilePaths(
  homeDir: string,
  runtimeEnv: Record<string, string | undefined>,
): string[] {
  const dataDir = resolveOpenCodeDataDir(homeDir, runtimeEnv);

  return [
    path.join(dataDir, OPENCODE_AUTH_FILE_NAME),
    path.join(dataDir, GOOGLE_APPLICATION_CREDENTIALS_FILE_NAME),
  ];
}

/**
 * Rewrite the OpenCode credential files the pre-snapshot scrub removed, for
 * a sandbox that survived an abandoned snapshot attempt. Normally these files
 * are materialized once during harness bootstrap and the running harness
 * keeps pointing at their paths (Google's auth library re-reads
 * GOOGLE_APPLICATION_CREDENTIALS per token mint, and OpenCode persists OAuth
 * refreshes back to auth.json), so restoring the same paths from the
 * deployment's current env values heals the live harness without a restart.
 * Files whose source env value is absent are skipped.
 */
export function rematerializeOpenCodeCredentialFiles(options: {
  homeDir: string;
  runtimeEnv: Record<string, string>;
  logger: { info(message: string): void; warn(message: string): void };
}): { failedSteps: string[] } {
  const failedSteps: string[] = [];
  // materializeInlineGoogleCredentials rewrites the env value to the file
  // path; work on a copy so the caller's env is untouched.
  const env = { ...options.runtimeEnv };

  try {
    materializeInlineGoogleCredentials(env, options.homeDir);
  } catch (error) {
    options.logger.warn(
      `[rematerializeOpenCodeCredentialFiles] Failed to rewrite Google application credentials file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    failedSteps.push('rewrite Google application credentials file');
  }

  const authContent = env[OPENCODE_AUTH_CONTENT_ENV_VAR_NAME];

  if (authContent) {
    try {
      const dataDir = resolveOpenCodeDataDir(options.homeDir, env);
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(dataDir, OPENCODE_AUTH_FILE_NAME),
        authContent,
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch (error) {
      options.logger.warn(
        `[rematerializeOpenCodeCredentialFiles] Failed to rewrite OpenCode auth file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      failedSteps.push('rewrite OpenCode auth file');
    }
  }

  return { failedSteps };
}

/**
 * OpenCode's Google Vertex provider reads GOOGLE_APPLICATION_CREDENTIALS as a
 * file path. Roomote accepts pasted JSON, so materialize it at the common
 * config-generation boundary before any provider process can observe it.
 * Throw on write failures rather than forwarding raw credentials to OpenCode,
 * whose file-not-found errors may echo the credential value.
 */
function materializeInlineGoogleCredentials(
  runtimeEnv: Record<string, string>,
  homeDir: string,
): void {
  const credentialsValue =
    runtimeEnv[GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME];

  if (!isInlineGoogleCredentialsValue(credentialsValue)) {
    return;
  }

  const openCodeDataDir = resolveOpenCodeDataDir(homeDir, runtimeEnv);
  const credentialsFilePath = path.join(
    openCodeDataDir,
    GOOGLE_APPLICATION_CREDENTIALS_FILE_NAME,
  );

  try {
    fs.mkdirSync(openCodeDataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(credentialsFilePath, credentialsValue, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown credentials write error';
    throw new Error(
      `Failed to materialize inline ${GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME} before starting OpenCode: ${message}`,
    );
  }

  runtimeEnv[GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME] = credentialsFilePath;
}

function normalizePackagedFolderName(
  value?: string | null,
): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  if (!SKILLS_FOLDER_NAME_PATTERN.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}
