import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { listInstanceSkillDefinitions } from '@roomote/db/server';
import {
  instanceSkillRuntimeDefinitionSchema,
  CUSTOM_SKILL_MAX_COUNT,
  CUSTOM_SKILL_MAX_DOCUMENT_BYTES,
  CUSTOM_SKILL_MAX_RUNTIME_BYTES,
  getCustomSkillBundleByteLength,
  renderManualSkillMarkdown,
} from '@roomote/types';

import { findTaskRunByRunTokenClaims } from '../lib/task-runs/find-task-run';
import { authenticatedProcedure, isRunToken, router } from '../trpc';

export const instanceSkillsRouter = router({
  listForRuntime: authenticatedProcedure
    .input(z.void())
    .output(
      z.array(instanceSkillRuntimeDefinitionSchema).max(CUSTOM_SKILL_MAX_COUNT),
    )
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
      const skills: z.infer<typeof instanceSkillRuntimeDefinitionSchema>[] = [];
      const names = new Set<string>();
      let totalBytes = 0;
      for (const definition of definitions) {
        const parsed =
          instanceSkillRuntimeDefinitionSchema.safeParse(definition);
        const bundleBytes = parsed.success
          ? getCustomSkillBundleByteLength(parsed.data)
          : 0;
        if (
          !parsed.success ||
          Buffer.byteLength(renderManualSkillMarkdown(parsed.data), 'utf8') >
            CUSTOM_SKILL_MAX_DOCUMENT_BYTES ||
          names.has(parsed.data.name) ||
          totalBytes + bundleBytes > CUSTOM_SKILL_MAX_RUNTIME_BYTES
        ) {
          continue;
        }
        skills.push(parsed.data);
        totalBytes += bundleBytes;
        names.add(parsed.data.name);
        if (skills.length === CUSTOM_SKILL_MAX_COUNT) break;
      }
      return skills;
    }),
});
