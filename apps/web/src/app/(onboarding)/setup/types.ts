import { PRODUCT_NAME } from '@roomote/types';

type SetupStepConfig = {
  id: string;
  title: string;
};

const SETUP_STEP_DEFINITIONS = [
  {
    id: 'welcome',
    title: `Welcome to ${PRODUCT_NAME}!`,
  },
  {
    id: 'auth-provider',
    title: 'Communication provider',
  },
  {
    id: 'auth-env-vars',
    title: 'Configure comms',
  },
  {
    id: 'env-vars',
    title: 'Configure inference',
  },
  {
    id: 'source-control-provider',
    title: 'Source control provider',
  },
  {
    id: 'source-control-config',
    title: 'Configure source control',
  },
  {
    id: 'source-control-connect',
    title: 'Connect source control',
  },
  {
    id: 'qualification-blocked',
    title: 'Thanks for your interest!',
  },
  {
    id: 'compute-provider',
    title: 'Sandbox provider',
  },
  {
    id: 'compute-config',
    title: 'Configure sandboxes',
  },
  {
    id: 'slack',
    title: 'Connect Slack',
  },
  {
    id: 'repo-selection',
    title: 'Set up environment',
  },
  {
    id: 'onboarding-agent',
    title: 'Set up environment',
  },
  {
    id: 'invoke',
    title: "You're all set!",
  },
] as const satisfies readonly SetupStepConfig[];

type SetupStepDefinition = (typeof SETUP_STEP_DEFINITIONS)[number];

export type SetupStep = SetupStepDefinition['id'];

export const SETUP_STEPS: SetupStep[] = SETUP_STEP_DEFINITIONS.map(
  (definition) => definition.id,
);

const SETUP_STEP_DEFINITION_MAP = Object.fromEntries(
  SETUP_STEP_DEFINITIONS.map((definition) => [definition.id, definition]),
) as {
  [K in SetupStep]: Extract<SetupStepDefinition, { id: K }>;
};

export function getSetupStepDefinition(step: SetupStep) {
  return SETUP_STEP_DEFINITION_MAP[step];
}

/**
 * Canonical URL for a signed-in setup step. The setup flow keeps the active
 * step in the query string (`/setup?step=<step-id>`) so the URL is the source
 * of truth for navigation, deep links, and browser back/forward. OAuth
 * callbacks and setup deep links depend on this exact shape.
 */
export function getSetupStepPath(step: SetupStep): string {
  return `/setup?step=${step}`;
}
