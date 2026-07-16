export type BuildWorkerEnvOptions = {
  authToken: string;
  sandboxExpiresAtMs?: number;
  extraEnv?: Record<string, string>;
  /**
   * Evaluated InferenceGateway feature flag. When true, gateway-covered
   * provider keys are withheld from the worker daemon env; the per-task
   * dequeue env routes the harness through the gateway instead.
   */
  inferenceGatewayEnabled?: boolean;
};
