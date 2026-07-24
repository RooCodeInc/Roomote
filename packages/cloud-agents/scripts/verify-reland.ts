#!/usr/bin/env npx tsx
import { routeTask } from '../src/server/router/router-service';
import type { RoutingContext } from '../src/server/router/types';

const context: RoutingContext = {
  taskDescription: 'Review the README in the Roomote repo',
  source: { type: 'slack', channelName: 'engineering' },
  availableEnvironments: [
    {
      id: 'env-roomote',
      name: 'Roomote',
      description: 'The main Roomote product — web app, API server, workers',
      repositoryNames: ['RooCodeInc/Roomote'],
    },
    {
      id: 'env-website',
      name: 'Roomote Website',
      description: 'Astro marketing website for Roomote',
      repositoryNames: ['RooCodeInc/roomote-website'],
    },
  ],
};

const decision = await routeTask(context);
console.log(
  JSON.stringify(
    {
      R_ROUTER_MODEL: process.env.R_ROUTER_MODEL ?? null,
      status: decision.status,
      ...(decision.status === 'routed'
        ? {
            workspace: decision.result.workspace,
            model: decision.result.debug ? undefined : undefined,
            debug: decision.result.debug,
          }
        : {}),
      ...(decision.status === 'fallback' ? { reason: decision.reason } : {}),
    },
    null,
    2,
  ),
);
process.exit(0);
