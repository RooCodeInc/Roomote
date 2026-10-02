vi.mock('../lib/task-tool-approvals', () => ({
  getTaskToolApprovalStatus: vi.fn(),
  requestTaskToolApproval: vi.fn(),
}));
vi.mock('../lib/task-runs/find-task-run', () => ({
  findTaskRunByRunTokenClaims: vi.fn(),
  findTaskRunForAccess: vi.fn(),
}));
vi.mock('../lib/auth/resolve-actor-scoped-user', () => ({
  resolveActorScopedUserContext: vi.fn(),
}));
vi.mock('./mcp-connections', () => ({
  resolveTaskRunMcpServerConfigs: vi.fn(),
}));

import { resolveIntegrationProxyAccess } from './tool-approvals';

describe('resolveIntegrationProxyAccess', () => {
  const url = 'https://roomote.example/trpc/toolApprovals.request';
  const headers = new Headers({ authorization: 'Bearer run-token' });

  it("reads the worker's origin and token from a plain request", () => {
    expect(
      resolveIntegrationProxyAccess(new Request(url, { headers })),
    ).toEqual({
      origin: 'https://roomote.example',
      authorization: 'Bearer run-token',
    });
  });

  it("reads them from the API's request wrapper", () => {
    expect(resolveIntegrationProxyAccess({ url, raw: { headers } })).toEqual({
      origin: 'https://roomote.example',
      authorization: 'Bearer run-token',
    });
  });

  it('is undefined without a token, a url, or a request', () => {
    expect(resolveIntegrationProxyAccess(undefined)).toBeUndefined();
    expect(resolveIntegrationProxyAccess({ url })).toBeUndefined();
    expect(
      resolveIntegrationProxyAccess({ url, raw: { headers: new Headers() } }),
    ).toBeUndefined();
    expect(
      resolveIntegrationProxyAccess({ url: 'not a url', raw: { headers } }),
    ).toBeUndefined();
  });
});
