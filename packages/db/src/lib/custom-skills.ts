import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  createCustomSkillInputSchema,
  environmentConfigSchema,
  renderManualSkillMarkdown,
  type CreateCustomSkillInput,
} from '@roomote/types';
import { db } from '../db';
import { environments, users } from '../schema';
import { updateEnvironmentDefinition } from './environment-definitions';

export class CreateCustomSkillError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 409,
  ) {
    super(message);
  }
}

export async function createCustomSkill(
  input: CreateCustomSkillInput & { actorUserId: string },
) {
  return db.transaction(async (tx) => {
    const [actor] = input.actorUserId
      ? await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, input.actorUserId),
              eq(users.role, 'admin'),
              isNull(users.deletedAt),
            ),
          )
          .for('share')
      : [];
    if (!actor) throw new CreateCustomSkillError('Admin access required', 403);
    const parsed = createCustomSkillInputSchema.parse(input);
    const { environmentIds: selectedIds, ...skill } = parsed;
    const environmentIds = [
      ...new Set(selectedIds.map((id) => id.toLowerCase())),
    ].sort();
    // Lock before reading configs; overlapping multi-environment creates use the same order.
    const selected = await tx
      .select()
      .from(environments)
      .where(
        and(
          inArray(environments.id, environmentIds),
          isNull(environments.userId),
          eq(environments.isEval, false),
        ),
      )
      .orderBy(asc(environments.id))
      .for('update');
    if (selected.length !== environmentIds.length)
      throw new CreateCustomSkillError(
        'Select only existing shared, non-evaluation environments. One or more selected IDs are unavailable.',
        400,
      );
    const updates = selected.map((environment) => {
      const config = environmentConfigSchema.parse(environment.config);
      if (
        config.manualSkills?.some((existing) => existing.name === skill.name)
      ) {
        throw new CreateCustomSkillError(
          `Environment "${environment.name}" already has a manual skill named "${skill.name}". Choose a different name or edit the existing skill in Settings. No environments were changed.`,
          409,
        );
      }
      return {
        environmentId: environment.id,
        config: environmentConfigSchema.parse({
          ...config,
          manualSkills: [...(config.manualSkills ?? []), skill],
        }),
      };
    });
    for (const update of updates) {
      await updateEnvironmentDefinition(tx, {
        environmentId: update.environmentId,
        fields: { config: update.config },
      });
    }
    const hash = createHash('sha256')
      .update(renderManualSkillMarkdown(skill))
      .digest('hex')
      .slice(0, 12);
    return {
      success: true as const,
      persisted: true as const,
      skillId: `manual@${skill.name}#${hash}`,
      name: skill.name,
      environmentIds,
      scope: 'selected_environments' as const,
    };
  });
}
