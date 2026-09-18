import { buildActiveRepositoryCatalog } from '../available-environments';

vi.mock('@roomote/db/server', () => ({}));

const github = (fullName: string) => ({
  fullName,
  sourceControlProvider: 'github',
  host: 'github.com',
});

describe('buildActiveRepositoryCatalog', () => {
  it('sorts names and collapses repeated rows for the same repository', () => {
    expect(
      buildActiveRepositoryCatalog([
        github('octo/widgets'),
        github('acme/app'),
        github('octo/widgets'),
      ]),
    ).toEqual({ names: ['acme/app', 'octo/widgets'], totalCount: 2 });
  });

  it('keeps same-name repositories on different providers or hosts distinguishable', () => {
    expect(
      buildActiveRepositoryCatalog([
        github('acme/app'),
        {
          fullName: 'acme/app',
          sourceControlProvider: 'gitlab',
          host: 'gitlab.example.com',
        },
        { fullName: 'acme/app', sourceControlProvider: 'gitea', host: null },
        github('octo/widgets'),
      ]),
    ).toEqual({
      names: [
        'acme/app (gitea)',
        'acme/app (github, github.com)',
        'acme/app (gitlab, gitlab.example.com)',
        'octo/widgets',
      ],
      totalCount: 4,
    });
  });

  it('caps the listed names while reporting the full count', () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      github(`acme/repo-${index}`),
    );

    expect(buildActiveRepositoryCatalog(rows, 2)).toEqual({
      names: ['acme/repo-0', 'acme/repo-1'],
      totalCount: 5,
    });
  });

  it('keeps every name when the deployment is under the default cap', () => {
    const rows = Array.from({ length: 149 }, (_, index) =>
      github(`acme/repo-${String(index).padStart(3, '0')}`),
    );

    const catalog = buildActiveRepositoryCatalog(rows);
    expect(catalog.names).toHaveLength(149);
    expect(catalog.totalCount).toBe(149);
  });
});
