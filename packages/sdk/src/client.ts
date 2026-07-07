// Re-export the worker client and types from the client module.
// This file exists for backwards compatibility with existing imports.
export {
  workerClient as client,
  workerHeartbeatClient,
  type AppRouter,
  type AppRouterInput,
  type AppRouterOutput,
} from './client/index';
