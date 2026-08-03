import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

import { router } from '../trpc';

import { authRouter } from './auth';
import { githubInstallationsRouter } from './github-installations';
import { slackInstallationsRouter } from './slack-installations';
import { linearSessionsRouter } from './linear-sessions';
import { repositoriesRouter } from './repositories';
import { taskRunsRouter } from './task-runs';
import { environmentsRouter } from './environments';
import { featureFlagsRouter } from './feature-flags';
import { mcpConnectionsRouter } from './mcp-connections';
import { userApiKeysRouter } from './user-api-keys';
import { llmUsageRouter } from './llm-usage';
import { statuspageRouter } from './statuspage';

export const appRouter = router({
  auth: authRouter,
  githubInstallations: githubInstallationsRouter,
  slackInstallations: slackInstallationsRouter,
  linearSessions: linearSessionsRouter,
  repositories: repositoriesRouter,
  taskRuns: taskRunsRouter,
  environments: environmentsRouter,
  featureFlags: featureFlagsRouter,
  mcpConnections: mcpConnectionsRouter,
  userApiKeys: userApiKeysRouter,
  llmUsage: llmUsageRouter,
  statuspage: statuspageRouter,
});

export type AppRouter = typeof appRouter;
export type AppRouterInput = inferRouterInputs<AppRouter>;
export type AppRouterOutput = inferRouterOutputs<AppRouter>;
