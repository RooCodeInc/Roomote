import { type AppRouterInput, type AppRouterOutput, client } from './client';

export type Repository = NonNullable<
  AppRouterOutput['repositories']['findRepository']
>;

export const listRepositories = (
  id: AppRouterInput['repositories']['listRepositories'],
) => client.repositories.listRepositories.query(id);

export const findRepository = (
  options: AppRouterInput['repositories']['findRepository'],
) => client.repositories.findRepository.query(options);

export const reportDefaultBranch = (
  options: AppRouterInput['repositories']['reportDefaultBranch'],
) => client.repositories.reportDefaultBranch.mutate(options);
