/**
 * Type-only exports for the SDK.
 *
 * This file re-exports types from the server router.
 * It should only be imported with `import type` to avoid pulling in server code.
 */
export type {
  AppRouter,
  AppRouterInput,
  AppRouterOutput,
} from './server/routers/app';
