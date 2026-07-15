import { getComputeProviderCapabilities } from '../compute-providers/capabilities';

describe('compute provider capabilities', () => {
  it.each(['docker', 'modal', 'daytona', 'e2b', 'blaxel'] as const)(
    'marks %s as supporting Docker projects',
    (provider) => {
      expect(
        getComputeProviderCapabilities(provider).supportsDockerProjects,
      ).toBe(true);
    },
  );
});
