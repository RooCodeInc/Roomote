import { getComputeProviderCapabilities } from '../compute-providers/capabilities';

describe('compute provider capabilities', () => {
  it.each(['docker', 'daytona', 'e2b', 'blaxel'] as const)(
    'marks %s as supporting container projects',
    (provider) => {
      expect(
        getComputeProviderCapabilities(provider).supportsContainerProjects,
      ).toBe(true);
    },
  );

  it('marks Modal as not supporting container projects', () => {
    expect(
      getComputeProviderCapabilities('modal').supportsContainerProjects,
    ).toBe(false);
  });
});
