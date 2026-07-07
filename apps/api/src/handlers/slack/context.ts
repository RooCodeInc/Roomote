import type { SlackNotifier } from '@roomote/slack';
import type { SlackInstallation } from '@roomote/db/server';

export interface SlackWebhookContext {
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  teamId: string;
}

export function createSlackWebhookContext(params: {
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  teamId: string;
}): SlackWebhookContext {
  return {
    slackInstallation: params.slackInstallation,
    slack: params.slack,
    teamId: params.teamId,
  };
}
