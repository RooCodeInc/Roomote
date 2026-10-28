import { readFileSync } from 'node:fs';

import { Env } from '@roomote/env';

/**
 * The shared secret the Brain presents to /api/brain/inference. Absent
 * means the route is closed: a deployment without this configured has no
 * Brain calling it, and an unauthenticated request must never fall through
 * to a provider key.
 */
export function getBrainGatewayToken(): string | null {
  const direct = Env.R_BRAIN_GATEWAY_TOKEN?.trim();

  if (direct) {
    return direct;
  }

  // Compose brings the Brain up without anyone choosing a value: the
  // container writes one to its volume on first boot and the app services
  // mount that read-only. Absent simply means no Brain is wired up yet.
  if (Env.R_BRAIN_GATEWAY_TOKEN_FILE) {
    try {
      return (
        readFileSync(Env.R_BRAIN_GATEWAY_TOKEN_FILE, 'utf8').trim() || null
      );
    } catch {
      return null;
    }
  }

  return null;
}
