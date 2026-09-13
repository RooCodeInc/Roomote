import type { QueryClient } from '@tanstack/react-query';

import { invalidateMcpIntegrationStatusQueries } from './invalidateMcpIntegrationStatusQueries';

it('invalidates every integration status projection', async () => {
  const invalidateQueries = vi.fn().mockResolvedValue(undefined);
  const query = (key: string) => ({ queryKey: () => [key] });
  const trpc = {
    mcpConnections: {
      effectiveIntegrations: query('effective'),
      deploymentEnablements: query('enablements'),
      userConnections: query('connections'),
      oauthReadiness: query('oauth'),
      availability: query('availability'),
    },
  };

  await invalidateMcpIntegrationStatusQueries(
    { invalidateQueries } as unknown as QueryClient,
    trpc as never,
  );

  expect(
    invalidateQueries.mock.calls.map(([options]) => options.queryKey),
  ).toEqual([
    ['effective'],
    ['enablements'],
    ['connections'],
    ['oauth'],
    ['availability'],
  ]);
});
