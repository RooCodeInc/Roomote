import { describe, expect, it, vi } from 'vitest';

import { FastAgentCodeModeTurnLifecycle } from '../fast-agent-code-mode-turn-lifecycle';

const integration = (id: string) => ({
  id,
  name: id,
  description: `${id} integration`,
  tools: [],
});

describe('FastAgentCodeModeTurnLifecycle', () => {
  it('keeps inactive turns free of partial code-mode state', async () => {
    const mountIntegration = vi.fn();
    const lifecycle = new FastAgentCodeModeTurnLifecycle({
      mountIntegration,
    });

    lifecycle.configure(
      {
        codeModeIntegrationsActive: false,
        directory: '/tmp/code-mode',
        mcpCapability: 'capability',
      },
      [integration('github')],
    );
    lifecycle.bindServer('http://127.0.0.1:9999');
    await lifecycle.mountNewlyConnected([integration('notion')]);

    expect(lifecycle.active).toBe(false);
    expect(mountIntegration).not.toHaveBeenCalled();
  });

  it('binds active turn state and mounts only newly connected integrations', async () => {
    const mountIntegration = vi.fn().mockResolvedValue(true);
    const lifecycle = new FastAgentCodeModeTurnLifecycle({
      mountIntegration,
    });

    lifecycle.configure(
      {
        codeModeIntegrationsActive: true,
        directory: '/tmp/code-mode',
        mcpCapability: 'capability',
      },
      [integration('github')],
    );
    lifecycle.bindServer('http://127.0.0.1:9999');
    await lifecycle.mountNewlyConnected([
      integration('github'),
      integration('notion'),
    ]);
    await lifecycle.mountNewlyConnected([integration('notion')]);

    expect(lifecycle.active).toBe(true);
    expect(mountIntegration).toHaveBeenCalledTimes(1);
    expect(mountIntegration).toHaveBeenCalledWith({
      serverUrl: 'http://127.0.0.1:9999',
      directory: '/tmp/code-mode',
      mcpCapability: 'capability',
      integrationId: 'notion',
    });
  });

  it('waits for the leased server before recording a new integration', async () => {
    const mountIntegration = vi.fn().mockResolvedValue(true);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const lifecycle = new FastAgentCodeModeTurnLifecycle({
      logger,
      mountIntegration,
    });
    lifecycle.configure(
      {
        codeModeIntegrationsActive: true,
        directory: '/tmp/code-mode',
        mcpCapability: 'capability',
      },
      [],
    );

    await lifecycle.mountNewlyConnected([integration('notion')]);
    expect(mountIntegration).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();

    lifecycle.bindServer('http://127.0.0.1:9999');
    await lifecycle.mountNewlyConnected([integration('notion')]);
    expect(mountIntegration).toHaveBeenCalledOnce();
  });

  it('retries a rejected live mount after the next turn reconfigures state', async () => {
    const mountIntegration = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const lifecycle = new FastAgentCodeModeTurnLifecycle({
      logger: { info: vi.fn(), warn: vi.fn() },
      mountIntegration,
    });
    const runtime = {
      codeModeIntegrationsActive: true,
      directory: '/tmp/code-mode',
      mcpCapability: 'capability',
    };

    lifecycle.configure(runtime, []);
    lifecycle.bindServer('http://127.0.0.1:9999');
    await lifecycle.mountNewlyConnected([integration('notion')]);
    await lifecycle.mountNewlyConnected([integration('notion')]);
    expect(mountIntegration).toHaveBeenCalledOnce();

    lifecycle.configure(runtime, []);
    lifecycle.bindServer('http://127.0.0.1:9999');
    await lifecycle.mountNewlyConnected([integration('notion')]);
    expect(mountIntegration).toHaveBeenCalledTimes(2);
  });
});
