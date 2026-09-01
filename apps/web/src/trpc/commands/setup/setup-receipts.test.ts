import { SETUP_RECEIPT_INPUT_KIND } from '@roomote/types';

import {
  buildSetupReceiptMessage,
  formatComputeReadinessReceipt,
  formatRecommendationApplicationReceipt,
  formatSourceConnectionReceipt,
  formatStarterSelectionReceipt,
} from './setup-receipts';

describe('setup transcript receipts', () => {
  it('builds a deterministic transcript-only user message', () => {
    const input = {
      sessionId: 'session-1',
      workflowVersion: 1,
      userId: 'user-1',
      kind: 'compute_readiness' as const,
      fingerprint: 'modal',
      text: 'Sandbox configured with Modal.',
      payload: { provider: 'modal' },
      ts: 123,
    };

    const first = buildSetupReceiptMessage(input);
    const second = buildSetupReceiptMessage({ ...input, ts: 456 });

    expect(second.eventId).toBe(first.eventId);
    expect(first).toMatchObject({
      eventType: 'roomote_runtime.user_prompt',
      role: 'user',
      contentBlocks: [{ type: 'text', text: input.text }],
      metadata: {
        visibleInTranscript: true,
        turnSource: 'platform_event',
        inputKind: SETUP_RECEIPT_INPUT_KIND,
        setupReceiptKind: 'compute_readiness',
      },
      payload: {
        setupReceipt: { kind: 'compute_readiness', provider: 'modal' },
      },
    });
  });

  it('formats readable receipts for every setup-card completion', () => {
    expect(
      formatSourceConnectionReceipt({
        providerLabels: ['GitHub'],
        repositoryCount: 1,
      }),
    ).toBe('GitHub connected with 1 repository.');
    expect(formatComputeReadinessReceipt('Modal')).toBe(
      'Sandbox configured with Modal.',
    );
    expect(
      formatStarterSelectionReceipt([
        'Speed up CI',
        'Security scan',
        'Fix flaky tests',
      ]),
    ).toBe('Selected Speed up CI, Security scan, and Fix flaky tests.');
    expect(
      formatRecommendationApplicationReceipt({
        action: 'saved',
        enabledTitles: ['Review code', 'Triage CI failures'],
      }),
    ).toBe('Saved Review code and Triage CI failures.');
    expect(
      formatRecommendationApplicationReceipt({
        action: 'skipped',
        enabledTitles: [],
      }),
    ).toBe('Skipped recommended automations.');
  });
});
