export type BuildWorkerEnvOptions = {
  authToken: string;
  sandboxExpiresAtMs?: number;
  extraEnv?: Record<string, string>;
};
