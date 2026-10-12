import type { IntegrationToolApprovalStatus } from '@roomote/types';

const DEFAULT_APPROVAL_POLL_MS = 1_500;

export type IntegrationToolApprovalWaitResult =
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'invalid'
  | 'aborted';

/**
 * Wait for a persisted approval to leave pending, optionally claiming an
 * approval at the runtime's execution boundary.
 */
export async function waitForIntegrationToolApproval(input: {
  readStatus: () => Promise<IntegrationToolApprovalStatus | 'not_found' | null>;
  claimApproved?: () => Promise<boolean>;
  signal?: AbortSignal;
  pollMs?: number;
  deadline?: number;
  expire?: () => Promise<void>;
}): Promise<IntegrationToolApprovalWaitResult> {
  for (;;) {
    if (input.signal?.aborted) return 'aborted';

    const status = await input.readStatus();
    if (input.signal?.aborted) return 'aborted';

    if (status === 'approved') {
      if (!input.claimApproved) return 'approved';
      const claimed = await input.claimApproved();
      if (input.signal?.aborted) return 'aborted';
      return claimed ? 'approved' : 'invalid';
    }
    if (status === 'expired') return 'expired';
    if (status !== 'pending') return 'rejected';

    if (input.deadline !== undefined && Date.now() >= input.deadline) {
      await input.expire?.();
      return 'expired';
    }

    await waitForPoll(input.pollMs ?? DEFAULT_APPROVAL_POLL_MS, input.signal);
  }
}

async function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
