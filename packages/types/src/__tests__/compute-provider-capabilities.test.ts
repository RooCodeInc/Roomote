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

  it('keeps Modal container projects disabled until VM sandboxes are supported', () => {
    expect(
      getComputeProviderCapabilities('modal').supportsContainerProjects,
    ).toBe(false);
  });
});
