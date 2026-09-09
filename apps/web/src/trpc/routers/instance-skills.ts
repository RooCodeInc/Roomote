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
  installInstanceMarketplaceSkillCommand,
  searchInstanceMarketplaceSkillsCommand,
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
  searchMarketplace: protectedProcedure
    .input(z.object({ query: z.string().max(200) }).strict())
    .query(({ ctx: { auth }, input }) =>
      searchInstanceMarketplaceSkillsCommand(auth, input),
    ),
  installMarketplace: protectedProcedure
    .input(z.object({ skillId: z.string().max(256) }).strict())
    .mutation(({ ctx: { auth }, input }) =>
      installInstanceMarketplaceSkillCommand(auth, input),
    ),
  update: protectedProcedure
    .input(
      customSkillDefinitionSchema
        .extend({ skillId: z.string().uuid() })
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
