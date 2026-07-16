import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { standbyPollMs: 5_000 },
  resolveConfig: vi.fn(),
  run: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  serviceConstructor: vi.fn(),
}));

vi.mock('./config', () => ({
  resolveDiscordGatewayConfig: mocks.resolveConfig,
}));

vi.mock('./service', () => ({
  DiscordGatewayService: class {
    constructor(...args: unknown[]) {
      mocks.serviceConstructor(...args);
    }

    run = mocks.run;
    stop = mocks.stop;
  },
}));

import { startDiscordGatewaySupervisor } from './embedded';

describe('startDiscordGatewaySupervisor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConfig.mockReturnValue(mocks.config);
  });

  it('starts inside the host process and waits for shutdown to finish', async () => {
    let finishRun: (() => void) | undefined;
    mocks.run.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRun = resolve;
      }),
    );
    mocks.stop.mockImplementation(async () => finishRun?.());
    const redis = { status: 'ready' };
    const env = { R_DISCORD_GATEWAY_SECRET: 'gateway-secret' };

    const supervisor = startDiscordGatewaySupervisor(redis as never, env);

    expect(mocks.resolveConfig).toHaveBeenCalledWith(env);
    expect(mocks.serviceConstructor).toHaveBeenCalledWith(redis, mocks.config);
    expect(mocks.run).toHaveBeenCalledOnce();

    await supervisor.stop();

    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it('contains an unexpected Gateway failure instead of crashing the host', async () => {
    const error = new Error('gateway unavailable');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mocks.run.mockRejectedValue(error);
    mocks.stop.mockResolvedValue();

    const supervisor = startDiscordGatewaySupervisor({} as never);
    await supervisor.stop();

    expect(consoleError).toHaveBeenCalledWith(
      '[discord-gateway] supervisor stopped unexpectedly: gateway unavailable',
    );
    consoleError.mockRestore();
  });
});
