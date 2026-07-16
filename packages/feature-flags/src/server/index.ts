/**
 * Feature flags package - Server-side exports.
 *
 * This module exports server-side functionality including
 * the evaluator and cache that require database and Redis access.
 */

export {
  FeatureFlagEvaluator,
  getFeatureFlagEvaluator,
  isInferenceGatewayEnabledForDeployment,
  resetFeatureFlagEvaluatorForTests,
} from '../evaluator';
export { MetadataCache } from '../cache';
export * from '../index';
