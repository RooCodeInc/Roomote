import { randomUUID } from 'node:crypto';

import { validateSessionEgressControllerToken } from '@roomote/auth';
import { SESSION_EGRESS_CONTROL_PLANE_PATH } from '@roomote/types';

import {
  authenticateSessionEgressPrincipal,
  createSessionEgressControllerClient,
} from '../session-egress';

vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createSessionEgressControllerToken: vi
    .fn()
    .mockResolvedValue('controller-token'),
  validateSessionEgressControllerToken: vi
    .fn()
    .mockRejectedValue(new Error('invalid')),
}));

beforeEach(() => vi.clearAllMocks());

it.each([
  'Bearer gateway-token',
  'bEaReR\tgateway-token',
  'BEARER \t gateway-token \t',
  'Bearer\u00a0gateway-token\u00a0',
  'Bearer\v\fgateway-token\t',
])('preserves bearer scheme and surrounding whitespace: %j', async (header) => {
  expect(
    await authenticateSessionEgressPrincipal(header, 'gateway-token'),
  ).toBe('gateway');
  expect(validateSessionEgressControllerToken).not.toHaveBeenCalled();
});

it.each([
  undefined,
  '',
  'Basic gateway-token',
  ' Bearer gateway-token',
  'Bearer',
  'Bearergateway-token',
  'Bearer \t ',
  'Bearer\r\ngateway-token',
  'Bearer gateway-token\r\n',
  'Bearer gateway\ntoken',
  'Bearer\rcontroller-token',
  'Bearer\ncontroller-token',
  'Bearer controller\u2028token',
  'Bearer controller\u2029token',
])(
  'rejects malformed bearer headers before token validation: %j',
  async (header) => {
    expect(
      await authenticateSessionEgressPrincipal(header, 'gateway-token'),
    ).toBeNull();
    expect(validateSessionEgressControllerToken).not.toHaveBeenCalled();
  },
);

it('passes a parsed controller token to validation without changing its case', async () => {
  vi.mocked(validateSessionEgressControllerToken).mockResolvedValueOnce({
    tokenType: 'session-egress-controller',
  });
  expect(
    await authenticateSessionEgressPrincipal(
      'bearer\tController-Token \t',
      'gateway-token',
    ),
  ).toBe('controller');
  expect(validateSessionEgressControllerToken).toHaveBeenCalledExactlyOnceWith(
    'Controller-Token',
  );
});

it('handles hostile long tab runs without token validation', async () => {
  const tabs = '\t'.repeat(200_000);
  for (const header of [`Bearer${tabs}`, `Bearer${tabs}\r\n`]) {
    expect(
      await authenticateSessionEgressPrincipal(header, 'gateway-token'),
    ).toBeNull();
  }
  expect(validateSessionEgressControllerToken).not.toHaveBeenCalled();
  expect(
    await authenticateSessionEgressPrincipal(
      `bEaReR${tabs}gateway-token${tabs}`,
      'gateway-token',
    ),
  ).toBe('gateway');
}, 2_000);

it.each([
  '',
  '/',
  '///',
  '/'.repeat(200_000),
  `${'/'.repeat(200_000)}suffix///`,
])(
  'normalizes only trailing slashes and preserves POST registration',
  async (suffix) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{}'));
    const client = createSessionEgressControllerClient({
      apiBaseUrl: `https://api.example.com${suffix}`,
      fetch,
    });
    const input = {
      runId: 1,
      provider: 'docker',
      connectorIdentity: randomUUID(),
      leaseSeconds: 3600,
    };
    await client.register(input);
    const kept = suffix.includes('suffix') ? suffix.slice(0, -3) : '';
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `https://api.example.com${kept}${SESSION_EGRESS_CONTROL_PLANE_PATH}/workloads`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer controller-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      },
    );
  },
  2_000,
);
