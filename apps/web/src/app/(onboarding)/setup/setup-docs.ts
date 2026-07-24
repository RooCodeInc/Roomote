import type { SetupStep } from './types';

type SetupDocsStep = SetupStep | 'email-account' | 'email-password';

type SetupDocsContext = {
  authProvider?: string | null;
  computeProvider?: string | null;
  modelProvider?: string | null;
  sourceControlProvider?: string | null;
};

const SETUP_DOC_PATHS: Record<SetupDocsStep, string | null> = {
  welcome: null,
  'email-account': 'self-hosting',
  'email-password': 'self-hosting',
  'auth-provider': 'communications',
  'auth-env-vars': 'communications',
  slack: 'providers/communications/slack',
  'env-vars': 'models',
  'source-control-provider': 'source-control',
  'source-control-config': 'source-control',
  'source-control-connect': 'source-control',
  'compute-provider': 'compute',
  'compute-config': 'compute',
  'repo-selection': 'environments',
  invoke: 'how-roomote-works',
};

export function getSetupDocsStep(step: string | null): SetupDocsStep {
  return step && step in SETUP_DOC_PATHS ? (step as SetupDocsStep) : 'welcome';
}

const AUTH_PROVIDER_DOC_PATHS: Record<string, string> = {
  discord: 'providers/communications/discord',
  microsoft: 'providers/communications/microsoft-teams',
  slack: 'providers/communications/slack',
  telegram: 'providers/communications/telegram',
};

const COMPUTE_PROVIDER_DOC_PATHS: Record<string, string> = {
  blaxel: 'providers/compute/blaxel',
  daytona: 'providers/compute/daytona',
  docker: 'providers/compute/docker',
  e2b: 'providers/compute/e2b',
  modal: 'providers/compute/modal',
};

const MODEL_PROVIDER_DOC_PATHS: Record<string, string> = {
  litellm: 'providers/inference/litellm',
  ollama: 'providers/inference/ollama',
  'openai-compatible': 'providers/inference/openai-compatible',
  vllm: 'providers/inference/vllm',
};

const SOURCE_CONTROL_PROVIDER_DOC_PATHS: Record<string, string> = {
  ado: 'providers/source-control/azure-devops',
  bitbucket: 'providers/source-control/bitbucket',
  gitea: 'providers/source-control/gitea',
  github: 'providers/source-control/github',
  gitlab: 'providers/source-control/gitlab',
};

export function getSetupDocsPath(
  step: SetupDocsStep,
  context: SetupDocsContext = {},
): string | null {
  if (step === 'auth-env-vars') {
    return (
      AUTH_PROVIDER_DOC_PATHS[context.authProvider ?? ''] ?? 'communications'
    );
  }

  if (step === 'slack') {
    return (
      AUTH_PROVIDER_DOC_PATHS[context.authProvider ?? ''] ??
      SETUP_DOC_PATHS[step]
    );
  }

  if (step === 'env-vars') {
    return MODEL_PROVIDER_DOC_PATHS[context.modelProvider ?? ''] ?? 'models';
  }

  if (step === 'source-control-config' || step === 'source-control-connect') {
    return (
      SOURCE_CONTROL_PROVIDER_DOC_PATHS[context.sourceControlProvider ?? ''] ??
      'source-control'
    );
  }

  if (step === 'compute-config') {
    return (
      COMPUTE_PROVIDER_DOC_PATHS[context.computeProvider ?? ''] ?? 'compute'
    );
  }

  return SETUP_DOC_PATHS[step];
}
