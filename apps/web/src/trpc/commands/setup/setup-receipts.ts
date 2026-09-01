import { createHash } from 'node:crypto';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  SETUP_RECEIPT_INPUT_KIND,
} from '@roomote/types';

export type SetupReceiptKind =
  | 'source_connection'
  | 'compute_readiness'
  | 'starter_selection'
  | 'recommendation_application';

function formatList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

export function formatSourceConnectionReceipt(input: {
  providerLabels: string[];
  repositoryCount: number;
}): string {
  const providers = formatList(input.providerLabels);
  const repositories = `${input.repositoryCount} ${
    input.repositoryCount === 1 ? 'repository' : 'repositories'
  }`;
  return `${providers} connected with ${repositories}.`;
}

export function formatComputeReadinessReceipt(providerLabel: string): string {
  return `Sandbox configured with ${providerLabel}.`;
}

export function formatStarterSelectionReceipt(taskTitles: string[]): string {
  return `Selected ${formatList(taskTitles)}.`;
}

export function formatRecommendationApplicationReceipt(input: {
  action: 'saved' | 'skipped';
  enabledTitles: string[];
}): string {
  if (input.action === 'skipped') return 'Skipped recommended automations.';
  if (input.enabledTitles.length === 0) {
    return 'Saved with no recommended automations enabled.';
  }
  return `Saved ${formatList(input.enabledTitles)}.`;
}

export function buildSetupReceiptMessage(input: {
  sessionId: string;
  workflowVersion: number;
  userId: string;
  kind: SetupReceiptKind;
  fingerprint: string;
  text: string;
  payload?: Record<string, unknown>;
  ts?: number;
}) {
  const digest = createHash('sha256')
    .update(
      `${input.sessionId}:v${input.workflowVersion}:${input.kind}:${input.fingerprint}`,
    )
    .digest('hex')
    .slice(0, 24);
  const turnId = `setup:receipt:${input.kind}:${digest}`;

  return {
    eventId: `${turnId}:user`,
    turnId,
    turnSeq: 0,
    ts: input.ts ?? Date.now(),
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    role: 'user' as const,
    contentBlocks: [{ type: 'text' as const, text: input.text }],
    metadata: {
      visibleInTranscript: true,
      turnSource: 'platform_event',
      inputKind: SETUP_RECEIPT_INPUT_KIND,
      setupReceiptKind: input.kind,
      userId: input.userId,
    },
    payload: {
      setupReceipt: {
        kind: input.kind,
        ...(input.payload ?? {}),
      },
    },
    source: 'web' as const,
  };
}
