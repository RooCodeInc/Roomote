import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { listInstanceSkillDefinitions } from '@roomote/db/server';
import {
  customSkillDefinitionSchema,
  CUSTOM_SKILL_MAX_COUNT,
  CUSTOM_SKILL_MAX_DOCUMENT_BYTES,
  renderManualSkillMarkdown,
} from '@roomote/types';

import { findTaskRunByRunTokenClaims } from '../lib/task-runs/find-task-run';
import { authenticatedProcedure, isRunToken, router } from '../trpc';

export const instanceSkillsRouter = router({
  listForRuntime: authenticatedProcedure
    .input(z.void())
    .output(z.array(customSkillDefinitionSchema).max(CUSTOM_SKILL_MAX_COUNT))
    .query(async ({ ctx }) => {
      if (
        !isRunToken(ctx.auth) ||
        !(await findTaskRunByRunTokenClaims(ctx.auth))
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This endpoint requires an active run token',
        });
      }

      const definitions = await listInstanceSkillDefinitions();
      const skills: z.infer<typeof customSkillDefinitionSchema>[] = [];
      const names = new Set<string>();
      for (const definition of definitions) {
        const parsed = customSkillDefinitionSchema.safeParse(definition);
        if (
          !parsed.success ||
          Buffer.byteLength(renderManualSkillMarkdown(parsed.data), 'utf8') >
            CUSTOM_SKILL_MAX_DOCUMENT_BYTES ||
          names.has(parsed.data.name)
        ) {
          continue;
        }
        skills.push(parsed.data);
        names.add(parsed.data.name);
        if (skills.length === CUSTOM_SKILL_MAX_COUNT) break;
      }
      return skills;
    }),
});
