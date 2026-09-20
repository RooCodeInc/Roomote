import type { SlackNotifier } from '@roomote/slack';
import type { SlackInstallation } from '@roomote/db/server';

import type { SlackFirstVisibleResponseTiming } from './helpers/first-visible-response-timing.js';

export interface SlackWebhookContext {
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  teamId: string;
  firstVisibleResponseTiming?: SlackFirstVisibleResponseTiming;
}

export function createSlackWebhookContext(params: {
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  teamId: string;
  firstVisibleResponseTiming?: SlackFirstVisibleResponseTiming;
}): SlackWebhookContext {
  return {
    slackInstallation: params.slackInstallation,
    slack: params.slack,
    teamId: params.teamId,
    firstVisibleResponseTiming: params.firstVisibleResponseTiming,
  };
}
