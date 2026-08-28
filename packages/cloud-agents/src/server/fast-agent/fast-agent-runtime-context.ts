export function isRoomoteTaskSandboxHost(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.ROOMOTE_TASK_ID?.trim());
}

export function isProductionRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return [env.NODE_ENV, env.R_APP_ENV, env.APP_ENV, env.ROOMOTE_APP_ENV].some(
    (value) => value?.trim().toLowerCase() === 'production',
  );
}

export function shouldUseCheckoutSkillRoots(
  env: NodeJS.ProcessEnv = process.env,
  checkoutSkillsAvailable: () => boolean = () => false,
): boolean {
  if (isRoomoteTaskSandboxHost(env)) return true;
  if (isProductionRuntime(env)) return false;
  return checkoutSkillsAvailable();
}

export function shouldOverrideFastProjectConfigForTaskSandbox(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isRoomoteTaskSandboxHost(env)) return false;

  const inheritedMode =
    env.OPENCODE_DISABLE_PROJECT_CONFIG?.trim().toLowerCase();
  return inheritedMode === '1' || inheritedMode === 'true';
}
