import { z } from 'zod';
import {
  createCustomSkillInputSchema,
  customSkillDefinitionSchema,
} from '@roomote/types';
import { createRouter, protectedProcedure } from '../init';
import {
  createInstanceSkillCommand,
  deleteInstanceSkillCommand,
  getInstanceSkillCommand,
  listInstanceSkillsCommand,
  updateInstanceSkillCommand,
} from '../commands/instance-skills';

const skillIdSchema = z.object({ skillId: z.string().uuid() }).strict();

export const instanceSkillsRouter = createRouter({
  list: protectedProcedure.query(({ ctx: { auth } }) =>
    listInstanceSkillsCommand(auth),
  ),
  get: protectedProcedure
    .input(skillIdSchema)
    .query(({ ctx: { auth }, input }) => getInstanceSkillCommand(auth, input)),
  create: protectedProcedure
    .input(createCustomSkillInputSchema)
    .mutation(({ ctx: { auth }, input }) =>
      createInstanceSkillCommand(auth, input),
    ),
  update: protectedProcedure
    .input(
      customSkillDefinitionSchema
        .extend({
          expectedVersion: z.number().int().positive(),
          skillId: z.string().uuid(),
        })
        .strict(),
    )
    .mutation(({ ctx: { auth }, input }) =>
      updateInstanceSkillCommand(auth, input),
    ),
  delete: protectedProcedure
    .input(skillIdSchema)
    .mutation(({ ctx: { auth }, input }) =>
      deleteInstanceSkillCommand(auth, input),
    ),
});
