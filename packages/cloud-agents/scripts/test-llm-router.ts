#!/usr/bin/env npx tsx

/**
 * Test script for the LLM Router
 *
 * This script allows you to test the LLM routing logic without needing
 * Slack, Linear, or GitHub webhooks. It calls the configured OpenCode CLI
 * with mock data and displays the routing decision.
 *
 * Usage:
 *   # Test a task with Slack source
 *   pnpm --filter @roomote/cloud-agents tsx scripts/test-llm-router.ts \
 *     --task "Fix the authentication bug in the login form" \
 *     --source slack
 *
 *   # Test with Linear source and custom context
 *   pnpm --filter @roomote/cloud-agents tsx scripts/test-llm-router.ts \
 *     --task "Explain how the caching layer works" \
 *     --source linear \
 *     --linear-issue "ENG-123" \
 *     --linear-project "Backend Services"
 *
 *   # Interactive mode
 *   pnpm --filter @roomote/cloud-agents tsx scripts/test-llm-router.ts --interactive
 *
 * Environment:
 *   Requires ROOMOTE_MODEL. Uses ROOMOTE_SMALL_MODEL when set.
 */

import { createInterface } from 'readline';
import { z } from 'zod';
import { CloudAgentType } from '@roomote/types';
import {
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_THREAD_MESSAGES,
  type RoutingContext,
  type RoutingSource,
  type RoutableAgent,
  type RoutableEnvironment,
  type RoutingWorkspace,
  type RoutingResult,
  type RoutingDecision,
} from '../src/server/router/types';
import { buildWorkspaceRoutingPrompt } from '../src/server/router/prompts/routing-prompt';
import {
  generateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES,
  resolveOpenCodeSmallModel,
} from '../src/server/non-task-provider-usage';

// Zod schema for validating and parsing LLM routing responses
const LLMRoutingResponseSchema = z.object({
  workspaceValue: z.string(),
  reasoning: z.string(),
  confidence: z.number().optional(),
  needsExternalLookup: z.boolean().optional(),
  externalReference: z.string().nullable().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock Data
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_AGENTS: RoutableAgent[] = [
  {
    id: 'agent-generalist',
    name: 'Generalist',
    type: CloudAgentType.StandardTask,
    createdAt: new Date('2024-01-01'),
  },
  {
    id: 'agent-generalist-2',
    name: 'Generalist',
    type: CloudAgentType.StandardTask,
    createdAt: new Date('2024-02-01'),
  },
];

const MOCK_ENVIRONMENTS: RoutableEnvironment[] = [
  {
    id: 'app-full',
    name: 'Full Stack',
    description: 'Frontend and backend together',
    repositoryNames: ['acme/frontend-app', 'acme/api'],
  },
  {
    id: 'ios',
    name: 'Mobile Stack',
    description: 'Mobile app with shared utilities and backend',
    repositoryNames: ['acme/mobile-app', 'acme/shared-utils', 'acme/api'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Router Logic (self-contained)
// ─────────────────────────────────────────────────────────────────────────────

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

function buildSourceContext(source: RoutingSource): string {
  switch (source.type) {
    case 'slack': {
      let slackContext = '**Source**: Slack\n';
      if (source.channelName) {
        slackContext += `**Channel**: ${source.channelName}\n`;
      }
      if (source.threadMessages?.length) {
        slackContext += `**Thread Context**:\n`;
        const messages = source.threadMessages.slice(-MAX_THREAD_MESSAGES);
        for (const msg of messages) {
          slackContext += `- ${msg.user}: ${truncateText(msg.text, 200)}\n`;
        }
      }
      return slackContext + '\n';
    }

    case 'linear': {
      let linearContext = '**Source**: Linear\n';
      linearContext += `**Issue**: ${source.issueIdentifier} - ${source.issueTitle}\n`;
      if (source.projectName) {
        linearContext += `**Project**: ${source.projectName}\n`;
      }
      if (source.teamName) {
        linearContext += `**Team**: ${source.teamName}\n`;
      }
      if (source.guidance?.system) {
        linearContext += `**Team Guidance**: ${truncateText(source.guidance.system, 500)}\n`;
      }
      if (source.guidance?.instructions) {
        linearContext += `**Session Instructions**: ${truncateText(source.guidance.instructions, 500)}\n`;
      }
      if (source.issueDescription) {
        linearContext += `**Description**: ${truncateText(source.issueDescription, 500)}\n`;
      }
      return linearContext + '\n';
    }

    case 'github': {
      let githubContext = '**Source**: GitHub\n';
      githubContext += `**Repository**: ${source.repository}\n`;
      if (source.issueOrPrTitle) {
        githubContext += `**Title**: ${source.issueOrPrTitle}\n`;
      }
      if (source.commentBody) {
        githubContext += `**Comment**: ${truncateText(source.commentBody, 300)}\n`;
      }
      return githubContext + '\n';
    }
  }
}

function buildContextPrompt(context: RoutingContext): string {
  let prompt = `**Task Description**:\n${truncateText(context.taskDescription, MAX_TASK_DESCRIPTION_LENGTH)}\n\n`;

  prompt += buildSourceContext(context.source);

  prompt += `**Available Agents**:\n`;
  for (const agent of context.availableAgents) {
    prompt += `- ${agent.type} [id: ${agent.id}]\n`;
  }

  if (context.availableEnvironments.length > 0) {
    prompt += `\n**Available Environments**:\n`;
    for (const env of context.availableEnvironments) {
      prompt += `- ${env.name}${env.description ? `: ${env.description}` : ''} (repos: ${env.repositoryNames.join(', ')})\n`;
    }
  }

  return prompt;
}

function mapWorkspace(
  value: string,
  context: RoutingContext,
): RoutingWorkspace | null {
  const exactMatch = context.availableEnvironments.find(
    (environment) => environment.name.toLowerCase() === value.toLowerCase(),
  );

  if (exactMatch) {
    return {
      type: 'environment',
      id: exactMatch.id,
      name: exactMatch.name,
    };
  }

  const normalizedValue = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  const normalizedMatch = context.availableEnvironments.find(
    (environment) =>
      environment.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '') === normalizedValue,
  );

  return normalizedMatch
    ? {
        type: 'environment',
        id: normalizedMatch.id,
        name: normalizedMatch.name,
      }
    : null;
}

function parseRoutingResponse(
  text: string,
  context: RoutingContext,
): RoutingResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in routing response');
  }

  const response = LLMRoutingResponseSchema.parse(JSON.parse(jsonMatch[0]));

  const workspace = mapWorkspace(response.workspaceValue, context);
  if (!workspace) {
    throw new Error(
      `Could not map routed workspace "${response.workspaceValue}" to an available environment`,
    );
  }

  return {
    agentType: CloudAgentType.StandardTask,
    workspace,
    reasoning: response.reasoning,
    workspaceOnly: true,
  };
}

async function routeTask(context: RoutingContext): Promise<RoutingDecision> {
  try {
    if (context.availableEnvironments.length === 0) {
      return {
        status: 'fallback',
        reason: 'No available environments for routing',
      };
    }

    const routingPrompt = buildWorkspaceRoutingPrompt();

    const contextPrompt = buildContextPrompt(context);

    const text = await generateTrackedNonTaskText({
      surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
      prompt: `${routingPrompt}\n\n## Current Request\n\n${contextPrompt}`,
    });

    const parsed = parseRoutingResponse(text, context);

    return { status: 'routed', result: parsed };
  } catch (error) {
    console.error('[LLM Router] Error during routing:', error);
    return {
      status: 'fallback',
      reason: error instanceof Error ? error.message : 'Unknown routing error',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface CLIOptions {
  task?: string;
  source: 'slack' | 'linear' | 'github';
  interactive: boolean;
  slackChannel?: string;
  linearIssue?: string;
  linearProject?: string;
  linearTeam?: string;
  githubRepo?: string;
  githubTitle?: string;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    source: 'slack',
    interactive: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--task':
      case '-t':
        options.task = nextArg;
        i++;
        break;
      case '--source':
      case '-s':
        if (
          nextArg === 'slack' ||
          nextArg === 'linear' ||
          nextArg === 'github'
        ) {
          options.source = nextArg;
        }
        i++;
        break;
      case '--interactive':
      case '-i':
        options.interactive = true;
        break;
      case '--slack-channel':
        options.slackChannel = nextArg;
        i++;
        break;
      case '--linear-issue':
        options.linearIssue = nextArg;
        i++;
        break;
      case '--linear-project':
        options.linearProject = nextArg;
        i++;
        break;
      case '--linear-team':
        options.linearTeam = nextArg;
        i++;
        break;
      case '--github-repo':
        options.githubRepo = nextArg;
        i++;
        break;
      case '--github-title':
        options.githubTitle = nextArg;
        i++;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
╭───────────────────────────────────────────────────────────────────────────────╮
│ LLM Router Test Script                                                        │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│ Usage:                                                                        │
│   pnpm --filter @roomote/cloud-agents tsx scripts/test-llm-router.ts  │
│     [options]                                                                 │
│                                                                               │
│ Options:                                                                      │
│   --task, -t <text>       Task description to route                           │
│   --source, -s <type>     Source type: slack, linear, github (default: slack) │
│   --interactive, -i       Interactive mode - prompts for task description     │
│   --slack-channel <name>  Slack channel name                                  │
│   --linear-issue <id>     Linear issue identifier (e.g., ENG-123)             │
│   --linear-project <name> Linear project name                                 │
│   --linear-team <name>    Linear team name                                    │
│   --github-repo <name>    GitHub repository (e.g., acme/backend-api)          │
│   --github-title <title>  GitHub issue/PR title                               │
│   --help, -h              Show this help message                              │
│                                                                               │
│ Examples:                                                                     │
│   # Test a coding task from Slack                                             │
│   tsx scripts/test-llm-router.ts \\                            │
│     -t "Fix the login bug" -s slack                                           │
│                                                                               │
│   # Test an explanation task from Linear                                      │
│   tsx scripts/test-llm-router.ts \\                            │
│     -t "Explain caching" -s linear --linear-issue "ENG-123"                   │
│                                                                               │
│   # Interactive mode                                                          │
│   tsx scripts/test-llm-router.ts -i                            │
│                                                                               │
│ Environment:                                                                  │
│   Requires ROOMOTE_MODEL. Uses ROOMOTE_SMALL_MODEL when set.          │
│                                                                               │
╰───────────────────────────────────────────────────────────────────────────────╯
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Routing Context
// ─────────────────────────────────────────────────────────────────────────────

function buildSource(options: CLIOptions, task: string): RoutingSource {
  switch (options.source) {
    case 'slack':
      return {
        type: 'slack',
        channelName: options.slackChannel ?? 'project-ios',
        threadMessages: [
          { text: 'Hey team, we need some help with this', user: 'Alice' },
          { text: task, user: 'Bob' },
        ],
      };
    case 'linear':
      return {
        type: 'linear',
        issueIdentifier: options.linearIssue ?? 'ENG-456',
        issueTitle: task.substring(0, 100),
        issueDescription: task,
        projectName: options.linearProject ?? 'Engineering',
        teamName: options.linearTeam ?? 'Platform',
      };
    case 'github':
      return {
        type: 'github',
        repository: options.githubRepo ?? 'acme/backend-api',
        issueOrPrTitle: options.githubTitle ?? task.substring(0, 100),
        issueOrPrBody: task,
        commentBody: task,
      };
  }
}

function buildContext(options: CLIOptions, task: string): RoutingContext {
  return {
    taskDescription: task,
    source: buildSource(options, task),
    availableAgents: MOCK_AGENTS,
    availableEnvironments: MOCK_ENVIRONMENTS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Display Utilities
// ─────────────────────────────────────────────────────────────────────────────

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function formatWorkspace(workspace: RoutingWorkspace): string {
  switch (workspace.type) {
    case 'environment':
      return `environment → ${workspace.name}`;
    case 'all_repositories':
      return 'all repositories';
  }
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

function printResult(
  task: string,
  options: CLIOptions,
  decision: RoutingDecision,
  durationMs: number,
): void {
  const sourceLabel =
    options.source.charAt(0).toUpperCase() + options.source.slice(1);
  const sourceDetail =
    options.source === 'slack'
      ? `(channel: ${options.slackChannel ?? '#engineering'})`
      : options.source === 'linear'
        ? `(issue: ${options.linearIssue ?? 'ENG-456'})`
        : `(repo: ${options.githubRepo ?? 'acme/backend-api'})`;

  console.log(`
${colors.cyan}╭───────────────────────────────────────────────────────────────────────────────╮${colors.reset}
${colors.cyan}│${colors.reset} ${colors.bold}LLM Router Test${colors.reset}                                                              ${colors.cyan}│${colors.reset}
${colors.cyan}├───────────────────────────────────────────────────────────────────────────────┤${colors.reset}
${colors.cyan}│${colors.reset} ${colors.dim}Model:${colors.reset} ${(resolveOpenCodeSmallModel() ?? 'ROOMOTE_SMALL_MODEL/ROOMOTE_MODEL').padEnd(63)} ${colors.cyan}│${colors.reset}
${colors.cyan}│${colors.reset} ${colors.dim}Duration:${colors.reset} ${(durationMs + 'ms').padEnd(60)} ${colors.cyan}│${colors.reset}
${colors.cyan}├───────────────────────────────────────────────────────────────────────────────┤${colors.reset}
${colors.cyan}│${colors.reset} ${colors.dim}Task:${colors.reset}                                                                        ${colors.cyan}│${colors.reset}`);

  const maxWidth = 73;
  const taskLines = wrapText(task, maxWidth);
  for (const line of taskLines) {
    console.log(
      `${colors.cyan}│${colors.reset}   ${line.padEnd(74)} ${colors.cyan}│${colors.reset}`,
    );
  }

  console.log(
    `${colors.cyan}│${colors.reset}                                                                               ${colors.cyan}│${colors.reset}
${colors.cyan}│${colors.reset} ${colors.dim}Source:${colors.reset} ${sourceLabel} ${sourceDetail}`.padEnd(
      88,
    ) + `${colors.cyan}│${colors.reset}`,
  );

  console.log(
    `${colors.cyan}├───────────────────────────────────────────────────────────────────────────────┤${colors.reset}`,
  );

  if (decision.status === 'routed') {
    const { result } = decision;

    console.log(
      `${colors.cyan}│${colors.reset} ${colors.bold}${colors.green}Result: ROUTED${colors.reset}                                                             ${colors.cyan}│${colors.reset}
${colors.cyan}│${colors.reset}                                                                               ${colors.cyan}│${colors.reset}
${colors.cyan}│${colors.reset}   ${colors.dim}Agent Type:${colors.reset} ${colors.bold}${result.agentType}${colors.reset}`.padEnd(
        100,
      ) + `${colors.cyan}│${colors.reset}`,
    );
    console.log(
      `${colors.cyan}│${colors.reset}   ${colors.dim}Workspace:${colors.reset} ${formatWorkspace(result.workspace)}`.padEnd(
        88,
      ) + `${colors.cyan}│${colors.reset}`,
    );
    console.log(`${colors.cyan}│${colors.reset}                                                                               ${colors.cyan}│${colors.reset}
${colors.cyan}│${colors.reset}   ${colors.dim}Reasoning:${colors.reset}                                                                  ${colors.cyan}│${colors.reset}`);

    const reasoningLines = wrapText(result.reasoning, maxWidth);
    for (const line of reasoningLines) {
      console.log(
        `${colors.cyan}│${colors.reset}   ${line.padEnd(74)} ${colors.cyan}│${colors.reset}`,
      );
    }
  } else if (decision.status === 'platform_answer') {
    console.log(`${colors.cyan}│${colors.reset} ${colors.bold}${colors.blue}Result: PLATFORM ANSWER${colors.reset}                                                    ${colors.cyan}│${colors.reset}
${colors.cyan}│${colors.reset}                                                                               ${colors.cyan}│${colors.reset}
${colors.cyan}│${colors.reset}   ${colors.dim}Answer:${colors.reset}                                                                     ${colors.cyan}│${colors.reset}`);

    const answerLines = wrapText(decision.result.answer, maxWidth);
    for (const line of answerLines) {
      console.log(
        `${colors.cyan}│${colors.reset}   ${line.padEnd(74)} ${colors.cyan}│${colors.reset}`,
      );
    }

    console.log(`${colors.cyan}│${colors.reset}                                                                               ${colors.cyan}│${colors.reset}
${colors.cyan}│${colors.reset}   ${colors.dim}Reasoning:${colors.reset}                                                                  ${colors.cyan}│${colors.reset}`);

    const reasoningLines = wrapText(decision.result.reasoning, maxWidth);
    for (const line of reasoningLines) {
      console.log(
        `${colors.cyan}│${colors.reset}   ${line.padEnd(74)} ${colors.cyan}│${colors.reset}`,
      );
    }
  } else {
    console.log(`${colors.cyan}│${colors.reset} ${colors.bold}${colors.yellow}Result: FALLBACK${colors.reset}                                                           ${colors.cyan}│${colors.reset}
${colors.cyan}│${colors.reset}                                                                               ${colors.cyan}│${colors.reset}
${colors.cyan}│${colors.reset}   ${colors.dim}Reason:${colors.reset}                                                                     ${colors.cyan}│${colors.reset}`);

    const reasonLines = wrapText(decision.reason, maxWidth);
    for (const line of reasonLines) {
      console.log(
        `${colors.cyan}│${colors.reset}   ${line.padEnd(74)} ${colors.cyan}│${colors.reset}`,
      );
    }

    console.log(
      `${colors.cyan}├───────────────────────────────────────────────────────────────────────────────┤${colors.reset}`,
    );
    console.log(
      `${colors.cyan}│${colors.reset} ${colors.red}Would show manual configuration UI or use defaults${colors.reset}                        ${colors.cyan}│${colors.reset}`,
    );
  }

  console.log(`${colors.cyan}╰───────────────────────────────────────────────────────────────────────────────╯${colors.reset}
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive Mode
// ─────────────────────────────────────────────────────────────────────────────

async function promptForTask(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log(
      `${colors.cyan}╭───────────────────────────────────────────────────────────────────────────────╮${colors.reset}`,
    );
    console.log(
      `${colors.cyan}│${colors.reset} ${colors.bold}LLM Router - Interactive Mode${colors.reset}                                                ${colors.cyan}│${colors.reset}`,
    );
    console.log(
      `${colors.cyan}╰───────────────────────────────────────────────────────────────────────────────╯${colors.reset}`,
    );
    console.log();

    rl.question(
      `${colors.bold}Enter task description:${colors.reset} `,
      (answer) => {
        rl.close();
        resolve(answer);
      },
    );
  });
}

async function interactiveLoop(options: CLIOptions): Promise<void> {
  while (true) {
    const task = await promptForTask();

    if (
      !task ||
      task.toLowerCase() === 'exit' ||
      task.toLowerCase() === 'quit'
    ) {
      console.log(`\n${colors.dim}Goodbye!${colors.reset}\n`);
      break;
    }

    const context = buildContext(options, task);
    const start = Date.now();
    const decision = await routeTask(context);
    const duration = Date.now() - start;

    printResult(task, options, decision, duration);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Parse args first so --help works without API key
  const options = parseArgs();

  if (options.interactive) {
    await interactiveLoop(options);
    return;
  }

  if (!options.task) {
    console.error(`
${colors.red}Error: No task provided.${colors.reset}

Use --task "your task description" or --interactive mode.
Run --help for usage information.
`);
    process.exit(1);
  }

  const context = buildContext(options, options.task);
  const start = Date.now();
  const decision = await routeTask(context);
  const duration = Date.now() - start;

  printResult(options.task, options, decision, duration);
}

main().catch((error) => {
  console.error(`${colors.red}Error:${colors.reset}`, error);
  process.exit(1);
});
