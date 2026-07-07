export type RuntimeBootstrapState = {
  hasExplicitBootstrap: boolean;
};

const RUNTIME_BOOTSTRAP_STATE_KEY = Symbol.for('roomote.runtimeBootstrapState');

export function getRuntimeBootstrapState(): RuntimeBootstrapState {
  const globalState = globalThis as typeof globalThis & {
    [RUNTIME_BOOTSTRAP_STATE_KEY]?: RuntimeBootstrapState;
  };

  globalState[RUNTIME_BOOTSTRAP_STATE_KEY] ??= {
    hasExplicitBootstrap: false,
  };

  return globalState[RUNTIME_BOOTSTRAP_STATE_KEY];
}
