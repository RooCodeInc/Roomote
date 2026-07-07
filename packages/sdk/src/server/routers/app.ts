import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

import { router } from '../trpc';

import { authRouter } from './auth';
import { githubInstallationsRouter } from './github-installations';
import { slackInstallationsRouter } from './slack-installations';
import { linearSessionsRouter } from './linear-sessions';
import { repositoriesRouter } from './repositories';
import { cloudJobsRouter } from './cloud-jobs';
import { environmentsRouter } from './environments';
import { featureFlagsRouter } from './feature-flags';
import { mcpConnectionsRouter } from './mcp-connections';
import { userApiKeysRouter } from './user-api-keys';

export const appRouter = router({
  auth: authRouter,
  githubInstallations: githubInstallationsRouter,
  slackInstallations: slackInstallationsRouter,
  linearSessions: linearSessionsRouter,
  repositories: repositoriesRouter,
  cloudJobs: cloudJobsRouter,
  environments: environmentsRouter,
  featureFlags: featureFlagsRouter,
  mcpConnections: mcpConnectionsRouter,
  userApiKeys: userApiKeysRouter,
});

export type AppRouter = typeof appRouter;
export type AppRouterInput = inferRouterInputs<AppRouter>;
export type AppRouterOutput = inferRouterOutputs<AppRouter>;
