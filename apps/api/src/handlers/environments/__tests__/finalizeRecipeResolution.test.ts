import { Hono } from 'hono';

import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { finalizeRecipeResolution } from '../finalizeRecipeResolution';

const {
  mockTaskRunFindFirst,
  mockFinalizeEnvironmentRecipeResolution,
  mockValidateResolvedRecipe,
  mockAdapter,
} = vi.hoisted(() => ({
  mockTaskRunFindFirst: vi.fn(),
  mockFinalizeEnvironmentRecipeResolution: vi
    .fn()
    .mockResolvedValue({ status: 'applied' }),
  mockValidateResolvedRecipe: vi.fn().mockReturnValue({ valid: true }),
  mockAdapter: {
    type: 'r-bioconductor',
    schemaVersion: 1,
    normalizeRequest: (request: { packages: string[] }) => ({
      packages: [...request.packages].sort(),
    }),
    computeRequestFingerprint: vi.fn().mockReturnValue('a'.repeat(64)),
    computeResolutionFingerprint: vi.fn().mockReturnValue('b'.repeat(64)),
    describeSetupRequest: vi.fn(),
    isCompatible: vi.fn(),
    validateResolvedRecipe: vi.fn().mockReturnValue({ valid: true }),
    buildVerificationInstructions: vi.fn(),
    fallbackDisplayName: 'R + Bioconductor Environment',
  },
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...original,
    finalizeEnvironmentRecipeResolution:
      mockFinalizeEnvironmentRecipeResolution,
    db: {
      query: {
        taskRuns: { findFirst: mockTaskRunFindFirst },
      },
    },
  };
});

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@roomote/cloud-agents/server')>();

  return {
    ...original,
    requireRecipeControlAdapter: vi.fn().mockReturnValue(mockAdapter),
  };
});

function createApp(authContext?: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.post('/environments/:id/recipe_resolution', finalizeRecipeResolution);

  return app;
}

function runToken(): RunTokenContext {
  return {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
  };
}

const resolvedRecipe = {
  type: 'r-bioconductor',
  schema_version: 1,
  request: { packages: ['DESeq2', 'airway'] },
  request_fingerprint: 'a'.repeat(64),
  resolution: {
    image:
      'bioconductor/bioconductor_docker@sha256:41ed449aa2181f330cdc8d0499a11a7435b04827ff926dc141584a34f65a12cb',
    r_version: '4.5.2',
    bioconductor_version: '3.21',
    packages: [
      { name: 'DESeq2', version: '1.48.2', repository: 'bioconductor' },
      { name: 'airway', version: '1.28.0', repository: 'bioconductor' },
    ],
    renv_lock: {
      R: { Version: '4.5.2' },
      Bioconductor: { Version: '3.21' },
      Packages: { DESeq2: {}, airway: {} },
    },
    resolution_fingerprint: 'b'.repeat(64),
  },
};

function resolutionRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost/environments/${id}/recipe_resolution`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('finalizeRecipeResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFinalizeEnvironmentRecipeResolution.mockResolvedValue({
      status: 'applied',
    });
    mockValidateResolvedRecipe.mockReturnValue({ valid: true });
  });

  it('finalizes when the bound verification task explicitly targets the environment', async () => {
    mockTaskRunFindFirst.mockResolvedValueOnce({
      taskId: 'task-bound',
      payload: { verifiesEnvironmentId: 'env-1' },
    });

    const app = createApp(runToken());
    const response = await app.request(
      resolutionRequest('env-1', { recipe: resolvedRecipe }),
    );

    expect(response.status).toBe(200);
    expect(mockFinalizeEnvironmentRecipeResolution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-1',
        verificationTaskId: 'task-bound',
        recipe: expect.objectContaining({
          request_fingerprint: 'a'.repeat(64),
        }),
      }),
    );
  });

  it('rejects tasks without an explicit environment target', async () => {
    mockTaskRunFindFirst.mockResolvedValueOnce({
      taskId: 'task-unrelated',
      payload: {},
    });

    const app = createApp(runToken());
    const response = await app.request(
      resolutionRequest('env-1', { recipe: resolvedRecipe }),
    );

    expect(response.status).toBe(403);
    expect(mockFinalizeEnvironmentRecipeResolution).not.toHaveBeenCalled();
  });

  it('rejects unresolved recipes at the API boundary', async () => {
    mockTaskRunFindFirst.mockResolvedValueOnce({
      taskId: 'task-bound',
      payload: { verifiesEnvironmentId: 'env-1' },
    });

    const app = createApp(runToken());
    const response = await app.request(
      resolutionRequest('env-1', {
        recipe: {
          type: 'r-bioconductor',
          schema_version: 1,
          request: { packages: ['DESeq2'] },
          request_fingerprint: 'a'.repeat(64),
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(mockFinalizeEnvironmentRecipeResolution).not.toHaveBeenCalled();
  });

  it('rejects resolutions whose fingerprints do not recompute', async () => {
    mockTaskRunFindFirst.mockResolvedValueOnce({
      taskId: 'task-bound',
      payload: { verifiesEnvironmentId: 'env-1' },
    });
    mockAdapter.computeRequestFingerprint.mockReturnValueOnce('c'.repeat(64));

    mockFinalizeEnvironmentRecipeResolution.mockImplementationOnce(
      async (
        _db,
        input: {
          acceptRecipeResolution: (recipe: unknown) => string | null;
        },
      ) => {
        const reason = input.acceptRecipeResolution(resolvedRecipe);
        return reason ? { status: 'rejected', reason } : { status: 'applied' };
      },
    );

    const app = createApp(runToken());
    const response = await app.request(
      resolutionRequest('env-1', { recipe: resolvedRecipe }),
    );

    expect(response.status).toBe(400);
  });

  it('returns 409 for stale verification attempts', async () => {
    mockTaskRunFindFirst.mockResolvedValueOnce({
      taskId: 'task-bound',
      payload: { verifiesEnvironmentId: 'env-1' },
    });
    mockFinalizeEnvironmentRecipeResolution.mockResolvedValueOnce({
      status: 'stale',
    });

    const app = createApp(runToken());
    const response = await app.request(
      resolutionRequest('env-1', { recipe: resolvedRecipe }),
    );

    expect(response.status).toBe(409);
  });
});
