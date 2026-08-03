import { Env, areCuratedIntegrationsDisabled } from './env';

export const CURATED_INTEGRATIONS_DISABLED_MESSAGE =
  'Integrations are disabled by the deployment operator.';

export function assertCuratedIntegrationsEnabled(
  disabledFlag:
    | string
    | boolean
    | undefined = Env.R_CURATED_INTEGRATIONS_DISABLED,
) {
  if (areCuratedIntegrationsDisabled(disabledFlag)) {
    throw new Error(CURATED_INTEGRATIONS_DISABLED_MESSAGE);
  }
}
