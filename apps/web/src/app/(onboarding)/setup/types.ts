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
    id: 'inference',
    title: 'Configure inference',
  },
  {
    id: 'env-vars',
    title: 'Configure inference provider',
  },
] as const satisfies readonly SetupStepConfig[];

type SetupStepDefinition = (typeof SETUP_STEP_DEFINITIONS)[number];

export type SetupStep = SetupStepDefinition['id'];

export const SETUP_STEPS: readonly SetupStep[] = SETUP_STEP_DEFINITIONS.map(
  (definition) => definition.id,
);

export function getSetupSteps(
  _hasCommunicationAuthProvider: boolean,
): readonly SetupStep[] {
  // Communication-provider configuration is excluded from the activation
  // path; the parameter remains for call-site stability.
  return SETUP_STEPS;
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
 * Canonical setup URL for a full query string. The setup URL carries both the
 * active `step` and the provider params the docs panel renders from, so every
 * writer builds the complete query and formats it here.
 */
export function getSetupPath(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `/setup?${query}` : '/setup';
}
