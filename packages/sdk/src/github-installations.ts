import { type AppRouterOutput, client } from './client';

export type GithubInstallation = NonNullable<
  AppRouterOutput['githubInstallations']['findFirst']
>;

export const findFirst = () => client.githubInstallations.findFirst.query();
