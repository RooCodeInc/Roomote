import {
  ACP_ENVELOPE_EVENT_TYPES,
  type AcpPersistedEnvelope,
} from '@roomote/types';

const { redisDel, redisSet } = vi.hoisted(() => ({
  redisDel: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ del: redisDel, set: redisSet }),
}));

import {
  claimShowWidgetFallbackDelivery,
  extractShowWidgetFallbackDelivery,
  releaseShowWidgetFallbackDelivery,
} from '../show-widget-fallback-delivery';

function buildEnvelope(
  payloadOverrides: Record<string, unknown> = {},
): AcpPersistedEnvelope {
  return {
    ts: 1,
    eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
    role: 'tool',
    protocol: 'roomote_runtime',
    contentBlocks: [],
    metadata: { toolCallId: 'call-1' },
    payload: {
      toolCallId: 'call-1',
      status: 'completed',
      isMcp: true,
      mcpServerName: 'roomote',
      mcpToolName: 'show_widget',
      output: JSON.stringify({
        success: true,
        shown: true,
        title: 'Plan',
        textFallback: 'Plan fallback',
      }),
      ...payloadOverrides,
    },
  };
}

describe('extractShowWidgetFallbackDelivery', () => {
  it('prefers the public app URL for a completed first-party widget result', () => {
    const originalAppUrl = process.env.R_APP_URL;
    const originalPublicUrl = process.env.R_PUBLIC_URL;
    process.env.R_APP_URL = 'http://internal.example.com';
    process.env.R_PUBLIC_URL = 'https://app.example.com';

    try {
      expect(
        extractShowWidgetFallbackDelivery(buildEnvelope(), 'task-1'),
      ).toEqual({
        toolCallId: 'call-1',
        title: 'Plan',
        textFallback: 'Plan fallback',
        widgetUrl: 'https://app.example.com/task/task-1#msg-1',
      });
    } finally {
      if (originalAppUrl === undefined) {
        delete process.env.R_APP_URL;
      } else {
        process.env.R_APP_URL = originalAppUrl;
      }
      if (originalPublicUrl === undefined) {
        delete process.env.R_PUBLIC_URL;
      } else {
        process.env.R_PUBLIC_URL = originalPublicUrl;
      }
    }
  });

  it.each([
    { mcpServerName: 'custom' },
    { mcpToolName: 'other_tool' },
    { status: 'failed' },
    { output: JSON.stringify({ success: false, textFallback: 'Nope' }) },
    { output: JSON.stringify({ success: true, shown: true }) },
  ])('rejects non-deliverable widget payloads: %o', (payloadOverrides) => {
    expect(
      extractShowWidgetFallbackDelivery(
        buildEnvelope(payloadOverrides),
        'task-1',
      ),
    ).toBeNull();
  });
});

describe('show_widget fallback delivery claims', () => {
  beforeEach(() => {
    redisDel.mockReset();
    redisSet.mockReset();
  });

  it('claims a tool call once with a bounded TTL', async () => {
    redisSet.mockResolvedValue('OK');

    await expect(
      claimShowWidgetFallbackDelivery({ runId: 42, toolCallId: 'call-1' }),
    ).resolves.toEqual({ claimed: true });

    expect(redisSet).toHaveBeenCalledWith(
      'show-widget-fallback:42:call-1',
      '1',
      'EX',
      604_800,
      'NX',
    );
  });

  it('reports duplicate claims and can release a failed delivery', async () => {
    redisSet.mockResolvedValue(null);
    redisDel.mockResolvedValue(1);

    await expect(
      claimShowWidgetFallbackDelivery({ runId: 42, toolCallId: 'call-1' }),
    ).resolves.toEqual({ claimed: false });

    await releaseShowWidgetFallbackDelivery({
      runId: 42,
      toolCallId: 'call-1',
    });

    expect(redisDel).toHaveBeenCalledWith('show-widget-fallback:42:call-1');
  });
});
