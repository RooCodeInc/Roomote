import { randomUUID } from 'node:crypto';

import { validateCredentialEgressControllerToken } from '@roomote/auth';
import { CREDENTIAL_EGRESS_CONTROL_PLANE_PATH } from '@roomote/types';

import {
  authenticateCredentialEgressPrincipal,
  createCredentialEgressControllerClient,
} from '../credential-egress';

vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createCredentialEgressControllerToken: vi
    .fn()
    .mockResolvedValue('controller-token'),
  validateCredentialEgressControllerToken: vi
    .fn()
    .mockRejectedValue(new Error('invalid')),
}));

beforeEach(() => vi.clearAllMocks());

it.each([
  'Bearer controller-token',
  'bEaReR\tcontroller-token',
  'BEARER \t controller-token \t',
  'Bearer\u00a0controller-token\u00a0',
  'Bearer\v\fcontroller-token\t',
])('preserves bearer scheme and surrounding whitespace: %j', async (header) => {
  vi.mocked(validateCredentialEgressControllerToken).mockResolvedValueOnce({
    tokenType: 'credential-egress-controller',
  });
  expect(await authenticateCredentialEgressPrincipal(header)).toBe(
    'controller',
  );
  expect(
    validateCredentialEgressControllerToken,
  ).toHaveBeenCalledExactlyOnceWith('controller-token');
});

it.each([
  undefined,
  '',
  'Basic controller-token',
  ' Bearer controller-token',
  'Bearer',
  'Bearercontroller-token',
  'Bearer \t ',
  'Bearer\r\ncontroller-token',
  'Bearer controller-token\r\n',
  'Bearer controller\ntoken',
  'Bearer\rcontroller-token',
  'Bearer\ncontroller-token',
  'Bearer controller\u2028token',
  'Bearer controller\u2029token',
])(
  'rejects malformed bearer headers before token validation: %j',
  async (header) => {
    expect(await authenticateCredentialEgressPrincipal(header)).toBeNull();
    expect(validateCredentialEgressControllerToken).not.toHaveBeenCalled();
  },
);

it('rejects a bearer the controller token validator refuses', async () => {
  expect(
    await authenticateCredentialEgressPrincipal(
      'Bearer not-a-controller-token',
    ),
  ).toBeNull();
  expect(
    validateCredentialEgressControllerToken,
  ).toHaveBeenCalledExactlyOnceWith('not-a-controller-token');
});

it('passes a parsed controller token to validation without changing its case', async () => {
  vi.mocked(validateCredentialEgressControllerToken).mockResolvedValueOnce({
    tokenType: 'credential-egress-controller',
  });
  expect(
    await authenticateCredentialEgressPrincipal('bearer\tController-Token \t'),
  ).toBe('controller');
  expect(
    validateCredentialEgressControllerToken,
  ).toHaveBeenCalledExactlyOnceWith('Controller-Token');
});

it('handles hostile long tab runs without token validation', async () => {
  const tabs = '\t'.repeat(200_000);
  for (const header of [`Bearer${tabs}`, `Bearer${tabs}\r\n`]) {
    expect(await authenticateCredentialEgressPrincipal(header)).toBeNull();
  }
  expect(validateCredentialEgressControllerToken).not.toHaveBeenCalled();
  vi.mocked(validateCredentialEgressControllerToken).mockResolvedValueOnce({
    tokenType: 'credential-egress-controller',
  });
  expect(
    await authenticateCredentialEgressPrincipal(
      `bEaReR${tabs}controller-token${tabs}`,
    ),
  ).toBe('controller');
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
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{}'));
    const client = createCredentialEgressControllerClient({
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
    expect(timeout).toHaveBeenCalledWith(10_000);
    const kept = suffix.includes('suffix') ? suffix.slice(0, -3) : '';
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `https://api.example.com${kept}${CREDENTIAL_EGRESS_CONTROL_PLANE_PATH}/workloads`,
      {
        method: 'POST',
        signal: expect.any(AbortSignal),
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
