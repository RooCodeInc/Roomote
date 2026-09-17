'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useSlackPeerConversationsExperiment() {
  return useDeploymentExperiment(
    'slackPeerConversations',
    'Failed to update Slack peer conversations.',
  );
}
