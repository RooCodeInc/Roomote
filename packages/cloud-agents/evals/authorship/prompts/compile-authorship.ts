import {
  AUTHORSHIP_RULES_SYSTEM_PROMPT,
  buildCompilePrompt,
  type AvailableSpecificUser,
} from '../../../src/server/authorship-rules';

interface PromptVars {
  authorshipInstructions: string;
  availableRepositoriesKey?: string;
  availableUsersKey?: string;
  availableRepositories?: string[];
  availableUsers?: AvailableSpecificUser[];
}

interface PromptInput {
  vars: PromptVars;
}

interface PromptMessage {
  role: 'system' | 'user';
  content: string;
}

const OUTPUT_CONTRACT = `
Return a single JSON object and nothing else.

JSON shape:
{
  "confidence": number | null,
  "issues": [
    {
      "severity": "error" | "warning",
      "message": string
    }
  ],
  "rules": [
    {
      "label": string,
      "conditions": {
        "sourceKinds": string[],
        "taskTypes": string[],
        "repositoryFullNames": string[],
        "humanCreated": boolean | null
      },
      "author": {
        "mode": "unchanged" | "roomote" | "matched_human" | "specific_user",
        "actor": null | {
          "userId": string | null,
          "displayName": string | null,
          "githubLogin": string | null,
          "githubUserId": number | null
        }
      },
      "prOwner": {
        "mode": "unchanged" | "inherit_author" | "none" | "matched_human" | "specific_user",
        "actor": null | {
          "userId": string | null,
          "displayName": string | null,
          "githubLogin": string | null,
          "githubUserId": number | null
        }
      },
      "rationale": string
    }
  ]
}
`.trim();

const REPOSITORY_FIXTURES: Record<string, string[]> = {
  standard: [
    'Roomote/example-app',
    'acme/backend',
    'acme/frontend',
    'acme/infra',
  ],
};

const USER_FIXTURES: Record<string, AvailableSpecificUser[]> = {
  brunoOnly: [
    {
      userId: 'user-bruno',
      displayName: 'Bruno Bergher',
      githubLogin: 'brunobergher',
      githubUserId: 101,
    },
  ],
  aliceOnly: [
    {
      userId: 'user-alice',
      displayName: 'Alice Nguyen',
      githubLogin: 'alice-nguyen',
      githubUserId: 202,
    },
  ],
  brunoAlice: [
    {
      userId: 'user-bruno',
      displayName: 'Bruno Bergher',
      githubLogin: 'brunobergher',
      githubUserId: 101,
    },
    {
      userId: 'user-alice',
      displayName: 'Alice Nguyen',
      githubLogin: 'alice-nguyen',
      githubUserId: 202,
    },
  ],
  brunoSam: [
    {
      userId: 'user-bruno',
      displayName: 'Bruno Bergher',
      githubLogin: 'brunobergher',
      githubUserId: 101,
    },
    {
      userId: 'user-sam',
      displayName: 'Sam Ops',
      githubLogin: 'samops',
      githubUserId: null,
    },
  ],
  defaultWithSam: [
    {
      userId: 'user-bruno',
      displayName: 'Bruno Bergher',
      githubLogin: 'brunobergher',
      githubUserId: 101,
    },
    {
      userId: 'user-alice',
      displayName: 'Alice Nguyen',
      githubLogin: 'alice-nguyen',
      githubUserId: 202,
    },
    {
      userId: 'user-sam',
      displayName: 'Sam Ops',
      githubLogin: 'samops',
      githubUserId: null,
    },
  ],
};

function parseJsonIfNeeded<T>(value: T | string | undefined): T | undefined {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    return undefined;
  }

  return JSON.parse(trimmed) as T;
}

export function resolveAvailableRepositories(vars: PromptVars): string[] {
  if (
    vars.availableRepositoriesKey &&
    REPOSITORY_FIXTURES[vars.availableRepositoriesKey]
  ) {
    return REPOSITORY_FIXTURES[vars.availableRepositoriesKey] ?? [];
  }

  return parseJsonIfNeeded<string[]>(vars.availableRepositories) ?? [];
}

export function resolveAvailableUsers(
  vars: PromptVars,
): AvailableSpecificUser[] {
  if (vars.availableUsersKey && USER_FIXTURES[vars.availableUsersKey]) {
    return USER_FIXTURES[vars.availableUsersKey] ?? [];
  }

  return parseJsonIfNeeded<AvailableSpecificUser[]>(vars.availableUsers) ?? [];
}

export default function generatePrompt({ vars }: PromptInput): PromptMessage[] {
  const compilePrompt = buildCompilePrompt({
    authorshipInstructions: vars.authorshipInstructions,
    availableRepositories: resolveAvailableRepositories(vars),
    availableUsers: resolveAvailableUsers(vars),
  });

  return [
    {
      role: 'system',
      content: AUTHORSHIP_RULES_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `${OUTPUT_CONTRACT}\n\n${compilePrompt}`,
    },
  ];
}
