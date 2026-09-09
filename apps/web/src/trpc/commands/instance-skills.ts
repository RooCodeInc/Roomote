import {
  createCustomSkill,
  createMarketplaceSkill,
  CreateCustomSkillError,
  deleteCustomSkill,
  getCustomSkill,
  listCustomSkills,
  updateCustomSkill,
} from '@roomote/db/server';
import { loadMarketplaceSkillBundle } from '@roomote/cloud-agents/server';
import { ZodError, type z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { createCustomSkillInputSchema } from '@roomote/types';
import type { UserAuthSuccess } from '@/types';
import { parseSkillId, runSkillsMarketplaceSearch } from './custom-skills';

type SkillDefinition = z.infer<typeof createCustomSkillInputSchema>;

async function withSkillErrors<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof CreateCustomSkillError) {
      const codes = {
        400: 'BAD_REQUEST',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
      } as const;
      throw new TRPCError({
        code: codes[error.status],
        message: error.message,
        cause: error,
      });
    }
    if (error instanceof ZodError) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: error.issues[0]?.message,
        cause: error,
      });
    }
    throw error;
  }
}

export function listInstanceSkillsCommand(auth: UserAuthSuccess) {
  return withSkillErrors(listCustomSkills(auth.userId));
}

export function getInstanceSkillCommand(
  auth: UserAuthSuccess,
  input: { skillId: string },
) {
  return withSkillErrors(getCustomSkill(auth.userId, input.skillId));
}

export function createInstanceSkillCommand(
  auth: UserAuthSuccess,
  input: SkillDefinition,
) {
  return withSkillErrors(
    createCustomSkill({ ...input, actorUserId: auth.userId }),
  );
}

export async function searchInstanceMarketplaceSkillsCommand(
  auth: UserAuthSuccess,
  input: { query: string },
) {
  await withSkillErrors(listCustomSkills(auth.userId));
  const query = input.query.trim();
  return query.length < 2 ? [] : runSkillsMarketplaceSearch(query);
}

export async function installInstanceMarketplaceSkillCommand(
  auth: UserAuthSuccess,
  input: { skillId: string },
) {
  await withSkillErrors(listCustomSkills(auth.userId));
  const selection = parseSkillId(input.skillId);
  if (selection.kind !== 'marketplace' || selection.isAllSelection) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Choose one marketplace skill to install.',
    });
  }
  let bundle: Awaited<ReturnType<typeof loadMarketplaceSkillBundle>>;
  try {
    bundle = await loadMarketplaceSkillBundle(selection.source, selection.name);
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Could not install this marketplace skill.',
      cause: error,
    });
  }
  return withSkillErrors(
    createMarketplaceSkill({
      actorUserId: auth.userId,
      ...bundle,
      marketplaceSource: bundle.source,
      marketplaceRevision: bundle.revision,
    }),
  );
}

export function updateInstanceSkillCommand(
  auth: UserAuthSuccess,
  input: SkillDefinition & { skillId: string },
) {
  return withSkillErrors(
    updateCustomSkill({ ...input, actorUserId: auth.userId }),
  );
}

export function deleteInstanceSkillCommand(
  auth: UserAuthSuccess,
  input: { skillId: string },
) {
  return withSkillErrors(
    deleteCustomSkill({ ...input, actorUserId: auth.userId }),
  );
}
