import { Env } from '@roomote/env';
import {
  buildIntegrationConnectionPreparation,
  type PrepareIntegrationConnectionInput,
} from '@roomote/types';

export function prepareIntegrationConnection(
  input: PrepareIntegrationConnectionInput,
) {
  return buildIntegrationConnectionPreparation(
    input,
    Env.R_PUBLIC_URL ?? Env.R_APP_URL,
  );
}
