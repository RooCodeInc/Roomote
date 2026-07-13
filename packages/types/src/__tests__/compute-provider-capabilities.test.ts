import { getComputeProviderCapabilities } from '../compute-providers/capabilities';

describe('compute provider capabilities', () => {
  it.each(['docker', 'modal', 'daytona', 'e2b', 'blaxel'] as const)(
    'marks %s as supporting container projects',
    (provider) => {
      expect(
        getComputeProviderCapabilities(provider).supportsContainerProjects,
      ).toBe(true);
    },
  );
});
