import type { SetupStep } from './types';

export type SetupDocsStep = SetupStep | 'email-account' | 'email-password';

const SETUP_DOC_PATHS: Record<SetupDocsStep, string> = {
  welcome: 'index',
  'email-account': 'self-hosting',
  'email-password': 'self-hosting',
  'auth-provider': 'communications',
  'auth-env-vars': 'communications',
  slack: 'providers/communications/slack',
  'env-vars': 'models',
  'source-control-provider': 'source-control',
  'source-control-config': 'source-control',
  'source-control-connect': 'source-control',
  'qualification-blocked': 'self-hosting',
  'compute-provider': 'compute',
  'compute-config': 'compute',
  'repo-selection': 'environments',
  invoke: 'how-roomote-works',
};

export function getSetupDocsStep(step: string | null): SetupDocsStep {
  return step && step in SETUP_DOC_PATHS ? (step as SetupDocsStep) : 'welcome';
}

export function getSetupDocsPath(step: SetupDocsStep): string {
  return SETUP_DOC_PATHS[step];
}
