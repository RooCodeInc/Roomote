import { createHash } from 'node:crypto';
import {
  environmentConfigSchema,
  environmentManualSkillSchema,
  renderManualSkillMarkdown,
} from '@roomote/types';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db';
import { environments } from '../schema';
import { updateEnvironmentDefinition } from './environment-definitions';

export class EnvironmentManualSkillValidationError extends Error {
  override name = 'EnvironmentManualSkillValidationError';
}

/** Caller must authorize deployment administration before invoking this helper. */
export async function createEnvironmentManualSkill(input: {
  name: string;
  description: string;
  content: string;
  environmentIds: string[];
}): Promise<{
  success: true;
  skillId: string;
  updatedEnvironmentIds: string[];
}> {
  const parsed = environmentManualSkillSchema
    .extend({
      environmentIds: z.array(z.string().uuid()).min(1),
    })
    .safeParse(input);
  if (!parsed.success) {
    throw new EnvironmentManualSkillValidationError(
      'Provide a valid manual skill and at least one environment UUID.',
    );
  }
  const { environmentIds, ...manualSkill } = parsed.data;
  const selectedIds = [
    ...new Set(environmentIds.map((id) => id.toLowerCase())),
  ].sort();

  return db.transaction(async (tx) => {
    // Lock before deriving replacement configs; identical ordering avoids deadlocks.
    const selected = await tx
      .select()
      .from(environments)
      .where(
        and(
          inArray(environments.id, selectedIds),
          isNull(environments.userId),
          eq(environments.isEval, false),
        ),
      )
      .orderBy(asc(environments.id))
      .for('update');
    if (selected.length !== selectedIds.length) {
      throw new EnvironmentManualSkillValidationError(
        'Selected environments must belong to this deployment.',
      );
    }
    for (const environment of selected) {
      const current = environmentConfigSchema.safeParse(environment.config);
      if (!current.success) {
        throw new EnvironmentManualSkillValidationError(
          'A selected environment has an invalid configuration.',
        );
      }
      if (
        current.data.manualSkills?.some(
          (skill) => skill.name === manualSkill.name,
        )
      ) {
        throw new EnvironmentManualSkillValidationError(
          `A selected environment already has a manual skill named "${manualSkill.name}".`,
        );
      }
      // Validate without replacing the raw config: parsing strips unknown properties.
      const nextConfig = {
        ...environment.config,
        manualSkills: [
          ...(environment.config.manualSkills ?? []),
          manualSkill,
        ].sort((left, right) => left.name.localeCompare(right.name)),
      };
      if (!environmentConfigSchema.safeParse(nextConfig).success) {
        throw new EnvironmentManualSkillValidationError(
          'The resulting environment configuration is invalid.',
        );
      }
      await updateEnvironmentDefinition(tx, {
        environmentId: environment.id,
        expectedConfig: environment.config,
        fields: { config: nextConfig },
      });
    }
    const variant = createHash('sha256')
      .update(renderManualSkillMarkdown(manualSkill))
      .digest('hex')
      .slice(0, 12);
    return {
      success: true,
      skillId: `manual@${manualSkill.name}#${variant}`,
      updatedEnvironmentIds: selectedIds,
    };
  });
}
