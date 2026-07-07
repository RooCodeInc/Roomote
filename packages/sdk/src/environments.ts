import { type AppRouterInput, type AppRouterOutput, client } from './client';

export type Environment = NonNullable<
  AppRouterOutput['environments']['findEnvironment']
>;

export type EnvironmentListItem = Awaited<
  AppRouterOutput['environments']['list']
>[number];

export const listEnvironments = () => client.environments.list.query();

export const findEnvironment = (
  options: AppRouterInput['environments']['findEnvironment'],
) => client.environments.findEnvironment.query(options);

export const updateSnapshotStatus = (
  options: AppRouterInput['environments']['updateSnapshotStatus'],
) => client.environments.updateSnapshotStatus.mutate(options);
