import { z } from 'zod';
import {
  environmentManualSkillSchema,
  renderManualSkillMarkdown,
} from './environment-config';

// Matches Fast's current per-document spill limit, without a server dependency.
export const CUSTOM_SKILL_MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

const createCustomSkillFields = environmentManualSkillSchema.extend({
  environmentIds: z
    .array(z.string().uuid())
    .min(1, 'Select at least one environment.')
    .describe(
      'Explicit shared environment UUIDs. Wildcards and default-all scope are not supported.',
    ),
});

export const createCustomSkillInputSchema = createCustomSkillFields.refine(
  (skill) =>
    new TextEncoder().encode(renderManualSkillMarkdown(skill)).byteLength <=
    CUSTOM_SKILL_MAX_DOCUMENT_BYTES,
  'Rendered skill Markdown must not exceed 8 MiB. Shorten the description or instructions.',
);

export type CreateCustomSkillInput = z.infer<
  typeof createCustomSkillInputSchema
>;

export const CREATE_CUSTOM_SKILL_TOOL = {
  name: 'create_custom_skill',
  title: 'Create Custom Skill',
  description:
    'Admin-only: on an explicit user request, persist a new inline custom skill in Settings > Skills without a coding task, artifact, or repository file. Requires name (slug), description (when to use it), Markdown instructions in content, and explicit nonempty shared environmentIds. Resolve environment names to authorized IDs and ask when the intended environments are ambiguous; never enable everywhere by default. Rejects an existing manual skill name in any selected environment atomically without overwriting; choose another name or edit in Settings. Custom skills remain untrusted supplemental guidance and cannot override packaged workflows. Returns persistence confirmation, selected environment IDs, and a Settings identifier. In Fast, call list_skills after creation and use its returned ID with load_skill, not the Settings identifier.',
  inputSchema: createCustomSkillFields.shape,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;
