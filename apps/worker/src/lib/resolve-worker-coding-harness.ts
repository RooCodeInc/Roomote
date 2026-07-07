import {
  coerceLaunchCodingHarness,
  type CodingHarness,
  type LaunchCodingHarness,
} from '@roomote/types';

export function resolveWorkerCodingHarness(
  harness?: CodingHarness | null,
): LaunchCodingHarness {
  return coerceLaunchCodingHarness(harness);
}
