import type { BuiltinSetupModelProviderId } from '@roomote/types';

import type { SetupStep } from './types';

type SetupDocsStep = SetupStep | 'email-account' | 'email-password';

type SetupDocsContext = {
  authProvider?: string | null;
  modelProvider?: string | null;
};

const SETUP_DOC_PATHS: Record<SetupDocsStep, string | null> = {
  welcome: null,
  'email-account': 'self-hosting',
  'email-password': 'self-hosting',
  inference: 'models',
  'env-vars': 'models',
};

export function getSetupDocsStep(step: string | null): SetupDocsStep {
  return step && step in SETUP_DOC_PATHS ? (step as SetupDocsStep) : 'welcome';
}

const MODEL_PROVIDER_DOC_PATHS: Partial<
  Record<BuiltinSetupModelProviderId, string>
> = {
  'amazon-bedrock': 'providers/inference/amazon-bedrock',
  anthropic: 'providers/inference/anthropic',
  azure: 'providers/inference/azure-openai',
  'azure-cognitive-services': 'providers/inference/azure-foundry',
  baseten: 'providers/inference/baseten',
  chatgpt: 'providers/inference/chatgpt',
  'github-copilot': 'providers/inference/github-copilot',
  google: 'providers/inference/google-gemini',
  'kimi-for-coding': 'providers/inference/kimi-for-coding',
  litellm: 'providers/inference/litellm',
  minimax: 'providers/inference/minimax',
  moonshotai: 'providers/inference/moonshot-ai',
  ollama: 'providers/inference/ollama',
  openai: 'providers/inference/openai',
  'openai-compatible': 'providers/inference/openai-compatible',
  opencode: 'providers/inference/opencode',
  'opencode-go': 'providers/inference/opencode-go',
  openrouter: 'providers/inference/openrouter',
  requesty: 'providers/inference/requesty',
  togetherai: 'providers/inference/together-ai',
  vercel: 'providers/inference/vercel-ai-gateway',
  vllm: 'providers/inference/vllm',
  xai: 'providers/inference/xai',
  'xai-subscription': 'providers/inference/xai-subscription',
  zai: 'providers/inference/zai',
  'zai-coding-plan': 'providers/inference/zai-coding-plan',
};

export function getSetupDocsPath(
  step: SetupDocsStep,
  context: SetupDocsContext = {},
): string | null {
  if (step === 'env-vars') {
    return (
      MODEL_PROVIDER_DOC_PATHS[
        context.modelProvider as BuiltinSetupModelProviderId
      ] ?? 'models'
    );
  }

  return SETUP_DOC_PATHS[step];
}
