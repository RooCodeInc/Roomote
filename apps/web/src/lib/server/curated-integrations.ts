import { Env, areCuratedIntegrationsEnabled } from './env';

export const CURATED_INTEGRATIONS_DISABLED_MESSAGE =
  'Integrations are disabled by the deployment operator.';

export function assertCuratedIntegrationsEnabled(
  value: string | boolean | undefined = Env.R_CURATED_INTEGRATIONS_ENABLED,
) {
  if (!areCuratedIntegrationsEnabled(value)) {
    throw new Error(CURATED_INTEGRATIONS_DISABLED_MESSAGE);
  }
}
