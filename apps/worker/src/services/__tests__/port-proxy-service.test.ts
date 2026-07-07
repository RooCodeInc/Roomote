import type http from 'node:http';

const { mockStartMultiplexAuthProxy } = vi.hoisted(() => ({
  mockStartMultiplexAuthProxy: vi.fn<() => Promise<http.Server>>(),
}));

vi.mock('../auth-proxy', () => ({
  startMultiplexAuthProxy: mockStartMultiplexAuthProxy,
}));

import { startPortProxies } from '../port-proxy-service';

describe('startPortProxies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartMultiplexAuthProxy.mockResolvedValue({
      close: (callback?: (err?: Error) => void) => {
        callback?.();
        return {} as http.Server;
      },
    } as http.Server);
  });

  it('passes per-port routing options through to the multiplex auth proxy', async () => {
    const unauthenticatedPorts = new Set(['PUBLIC']);
    const wildcardPrefixPorts = new Set(['PREVIEW']);

    await startPortProxies({
      proxyPorts: {
        DASHBOARD: 49152,
        API: 49152,
      },
      appPorts: {
        DASHBOARD: 3000,
        API: 3001,
      },
      taskId: 'task_123',
      publicKey: 'base64-public-key',
      unauthenticatedPorts,
      subdomains: {
        DASHBOARD: 'dashboard.pocketflows',
      },
      wildcardPrefixPorts,
      authCookieName: 'preview_auth_nested',
      authBypassPaths: {
        DASHBOARD: ['/health'],
      },
      authBypassHeaderValue: 'bypass-token',
      authBypassHeaderName: 'x-roomote-bypass',
    });

    expect(mockStartMultiplexAuthProxy).toHaveBeenCalledWith({
      listenPort: 49152,
      portMapping: {
        DASHBOARD: 3000,
        API: 3001,
      },
      publicKey: 'base64-public-key',
      taskId: 'task_123',
      unauthenticatedPorts,
      subdomains: {
        DASHBOARD: 'dashboard.pocketflows',
      },
      wildcardPrefixPorts,
      authCookieName: 'preview_auth_nested',
      authBypassPaths: {
        DASHBOARD: ['/health'],
      },
      authBypassHeaderValue: 'bypass-token',
      authBypassHeaderName: 'x-roomote-bypass',
    });
  });
});
