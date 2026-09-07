import {
  isProductionRuntime,
  isRoomoteTaskSandboxHost,
  shouldOverrideFastProjectConfigForTaskSandbox,
  shouldUseCheckoutSkillRoots,
} from '../fast-agent-runtime-context';

describe('Fast agent runtime context', () => {
  it('recognizes the existing outer-task marker', () => {
    expect(isRoomoteTaskSandboxHost({ ROOMOTE_TASK_ID: ' task-123 ' })).toBe(
      true,
    );
    expect(isRoomoteTaskSandboxHost({ ROOMOTE_TASK_ID: ' ' })).toBe(false);
  });

  it.each([
    ['NODE_ENV', { NODE_ENV: 'production' }],
    ['R_APP_ENV', { R_APP_ENV: 'production' }],
    ['APP_ENV', { APP_ENV: 'production' }],
    ['ROOMOTE_APP_ENV', { ROOMOTE_APP_ENV: 'production' }],
  ])('recognizes production from %s', (_name, env) => {
    expect(isProductionRuntime(env)).toBe(true);
  });

  it('does not inspect checkout paths for any ordinary production host', () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { R_APP_ENV: 'production' },
      { APP_ENV: 'production' },
      { ROOMOTE_APP_ENV: 'production' },
    ]) {
      const checkoutSkillsAvailable = vi.fn(() => true);
      expect(shouldUseCheckoutSkillRoots(env, checkoutSkillsAvailable)).toBe(
        false,
      );
      expect(checkoutSkillsAvailable).not.toHaveBeenCalled();
    }
  });

  it('uses checkout paths for local development only when they exist', () => {
    expect(shouldUseCheckoutSkillRoots({}, () => true)).toBe(true);
    expect(shouldUseCheckoutSkillRoots({}, () => false)).toBe(false);
  });

  it('lets Roomote-on-Roomote override the inherited restriction without changing it in the parent', () => {
    const env = {
      NODE_ENV: 'production',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      ROOMOTE_TASK_ID: 'outer-task',
    };
    expect(shouldUseCheckoutSkillRoots(env, () => false)).toBe(true);
    expect(shouldOverrideFastProjectConfigForTaskSandbox(env)).toBe(true);
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
  });

  it('preserves an inherited restriction for an ordinary host', () => {
    expect(
      shouldOverrideFastProjectConfigForTaskSandbox({
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      }),
    ).toBe(false);
  });
});
