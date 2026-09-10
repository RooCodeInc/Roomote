import { type AppRouterOutput, client } from './client';

export type InstanceSkillDefinition =
  AppRouterOutput['instanceSkills']['listForRuntime'][number];

export const listForRuntime = () =>
  client.instanceSkills.listForRuntime.query();
