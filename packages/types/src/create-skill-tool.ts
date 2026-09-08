import { z } from 'zod';

import { environmentManualSkillSchema } from './environment-config';

export const createSkillSchema = environmentManualSkillSchema.extend({
  environmentIds: z
    .array(z.string().uuid())
    .min(1)
    .describe(
      'Explicit non-empty array of environment UUIDs returned by list_environments. Select the environments where this skill should be persisted.',
    ),
});

export type CreateSkillInput = z.infer<typeof createSkillSchema>;

export const CREATE_SKILL_TOOL = {
  name: 'create_skill',
  title: 'Create Skill',
  description:
    'Admin-only creation of a manual skill persisted in explicitly selected environments and visible in Settings > Skills. List environments first using manage_tasks with action "list_environments", then provide their exact UUIDs in environmentIds. Creates a new skill only; never overwrites an existing skill. No repository SKILL.md file is required. To invoke it, use $name in a NEW task selecting one of those environments. Do not promise that currently active tasks reload their available skills. Returns the skill ID, updated environment IDs, name, invocation, Settings URL, and availability note.',
  inputSchema: createSkillSchema.shape,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;
