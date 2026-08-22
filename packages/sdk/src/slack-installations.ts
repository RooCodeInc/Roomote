import { type AppRouterInput, type AppRouterOutput, client } from './client';

export type SlackInstallation = NonNullable<
  AppRouterOutput['slackInstallations']['findFirst']
>;

export const findFirst = () => client.slackInstallations.findFirst.query();

export const findByTeamId = (
  input: AppRouterInput['slackInstallations']['findByTeamId'],
) => client.slackInstallations.findByTeamId.query(input);

export const drainSlackMessages = (
  input: AppRouterInput['slackInstallations']['drainSlackMessages'],
) => client.slackInstallations.drainSlackMessages.mutate(input);
