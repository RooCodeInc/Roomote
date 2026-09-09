import {
  createCustomSkill,
  CreateCustomSkillError,
  deleteCustomSkill,
  getCustomSkill,
  listCustomSkills,
  updateCustomSkill,
} from '@roomote/db/server';
import { ZodError, type z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { createCustomSkillInputSchema } from '@roomote/types';
import type { UserAuthSuccess } from '@/types';

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
