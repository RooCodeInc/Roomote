import { Env } from './env';

const REQUEST_TIMEOUT_MS = 5_000;

type ProductUpdatesSource = 'setup' | 'onboarding';

/** Sends opt-in subscriptions separately from anonymous telemetry. */
export async function subscribeToProductUpdates(
  email: string | null,
  source: ProductUpdatesSource,
): Promise<void> {
  if (!email) {
    return;
  }

  try {
    await fetch(
      `${Env.R_PING_BASE_URL.replace(/\/+$/, '')}/v1/emails/subscribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    // Subscription delivery must not affect onboarding completion.
  }
}
