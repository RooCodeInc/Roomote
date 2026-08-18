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
    id: 'slack',
    title: 'Connect Slack',
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
    id: 'automation-recommendations',
    title: 'Automation recommendations',
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
    id: 'repo-selection',
    title: 'Set up environment',
  },
  {
    id: 'invoke',
    title: "That's it!",
  },
] as const satisfies readonly SetupStepConfig[];

type SetupStepDefinition = (typeof SETUP_STEP_DEFINITIONS)[number];

export type SetupStep = SetupStepDefinition['id'];

export const SETUP_STEPS: readonly SetupStep[] = SETUP_STEP_DEFINITIONS.map(
  (definition) => definition.id,
);

const EMAIL_PASSWORD_SETUP_ORDER_POLICY = {
  move: ['auth-provider', 'auth-env-vars', 'slack'],
  after: 'source-control-connect',
} as const satisfies {
  move: readonly SetupStep[];
  after: SetupStep;
};

const EMAIL_PASSWORD_MOVED_SETUP_STEPS = new Set<SetupStep>(
  EMAIL_PASSWORD_SETUP_ORDER_POLICY.move,
);

const EMAIL_PASSWORD_SETUP_STEPS: readonly SetupStep[] = SETUP_STEPS.flatMap(
  (step) => {
    if (step === EMAIL_PASSWORD_SETUP_ORDER_POLICY.after) {
      return [step, ...EMAIL_PASSWORD_SETUP_ORDER_POLICY.move];
    }

    return EMAIL_PASSWORD_MOVED_SETUP_STEPS.has(step) ? [] : [step];
  },
);

export function getSetupSteps(
  hasCommunicationAuthProvider: boolean,
): readonly SetupStep[] {
  return hasCommunicationAuthProvider
    ? SETUP_STEPS
    : EMAIL_PASSWORD_SETUP_STEPS;
}

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

/**
 * Canonical setup URL for a full query string. The setup URL carries both the
 * active `step` and the provider params the docs panel renders from, so every
 * writer builds the complete query and formats it here.
 */
export function getSetupPath(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `/setup?${query}` : '/setup';
}
