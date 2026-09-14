import { resolveSessionProxyConfig } from './authenticated-proxy';
import { createSelfSignedConnectorCa } from './connector-certificate';

describe('authenticated Session proxy configuration', () => {
  it('is disabled unless explicitly configured, and rejects partial setup', () => {
    expect(
      resolveSessionProxyConfig({ TRPC_URL: 'https://api.example.com' }),
    ).toBeNull();
    expect(() =>
      resolveSessionProxyConfig({
        TRPC_URL: 'https://api.example.com',
        SESSION_EGRESS_AUTHENTICATED_PROXY_URL: 'https://proxy.example.com',
      }),
    ).toThrow('both');
  });
  it('accepts public trust only and does not require a per-workload connector', () => {
    const ca = createSelfSignedConnectorCa();
    const env = {
      TRPC_URL: 'https://api.example.com',
      SESSION_EGRESS_AUTHENTICATED_PROXY_URL: 'https://proxy.example.com:8444',
      SESSION_EGRESS_AUTHENTICATED_PROXY_CA_CERT_FILE: '/public.pem',
    };
    const config = resolveSessionProxyConfig(env, () => ca.certificatePem)!;
    expect(config.endpoint).toBe('https://proxy.example.com:8444');
    expect(config.caBundle).toContain(ca.certificatePem.trim());
    expect(config.caBundle).not.toContain('PRIVATE KEY');
    expect(() =>
      resolveSessionProxyConfig(
        env,
        () => ca.certificatePem + ca.privateKeyPem,
      ),
    ).toThrow('public certificates only');
  });
  it.each([
    'http://proxy.example.com',
    'https://user:password@proxy.example.com',
    'https://proxy.example.com/path',
    'https://proxy.example.com?key=value',
  ])('rejects invalid endpoint %s', (endpoint) => {
    expect(() =>
      resolveSessionProxyConfig(
        {
          TRPC_URL: 'https://api.example.com',
          SESSION_EGRESS_AUTHENTICATED_PROXY_URL: endpoint,
          SESSION_EGRESS_AUTHENTICATED_PROXY_CA_CERT_FILE: '/public.pem',
        },
        () => '',
      ),
    ).toThrow('HTTPS origin');
  });
});
