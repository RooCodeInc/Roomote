import { buildActiveRepositoryCatalog } from '../available-environments';

vi.mock('@roomote/db/server', () => ({}));

describe('buildActiveRepositoryCatalog', () => {
  it('sorts and de-duplicates active repository names', () => {
    expect(
      buildActiveRepositoryCatalog([
        'octo/widgets',
        'acme/app',
        'octo/widgets',
      ]),
    ).toEqual({ names: ['acme/app', 'octo/widgets'], totalCount: 2 });
  });

  it('caps the listed names while reporting the full count', () => {
    const fullNames = Array.from(
      { length: 5 },
      (_, index) => `acme/repo-${index}`,
    );

    expect(buildActiveRepositoryCatalog(fullNames, 2)).toEqual({
      names: ['acme/repo-0', 'acme/repo-1'],
      totalCount: 5,
    });
  });

  it('keeps every name when the deployment is under the default cap', () => {
    const fullNames = Array.from(
      { length: 149 },
      (_, index) => `acme/repo-${String(index).padStart(3, '0')}`,
    );

    const catalog = buildActiveRepositoryCatalog(fullNames);
    expect(catalog.names).toHaveLength(149);
    expect(catalog.totalCount).toBe(149);
  });
});
