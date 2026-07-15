import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  performSourceControlRequest,
  requestSourceControlJson,
} from '../source-control-pull-request-http';

describe('source-control-pull-request-http', () => {
  it('builds performRequest headers and optional JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));

    await performSourceControlRequest({
      fetchImpl,
      method: 'POST',
      url: 'https://example.test/api',
      tokenHeader: { name: 'Authorization', value: 'token abc' },
      body: { title: 'x' },
    });

    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/api', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'token abc',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'x' }),
    });
  });

  it('parses successful JSON responses with the provided schema', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 7 }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const result = await requestSourceControlJson({
      fetchImpl,
      method: 'POST',
      url: 'https://example.test/create',
      tokenHeader: { name: 'PRIVATE-TOKEN', value: 'glpat' },
      body: { name: 'n' },
      schema: z.object({ id: z.number() }),
    });

    expect(result).toEqual({ id: 7 });
  });

  it('rejects unexpected status codes with a shared failure message', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('nope', {
          status: 403,
          statusText: 'Forbidden',
        }),
    );

    await expect(
      requestSourceControlJson({
        fetchImpl,
        url: 'https://example.test/read',
        tokenHeader: { name: 'Authorization', value: 'token abc' },
        schema: z.object({}),
        acceptedStatuses: [200],
      }),
    ).rejects.toThrow('Source control API request failed: 403 Forbidden: nope');
  });
});
