vi.mock('@roomote/db/server', () => ({
  db: {},
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
  githubInstallations: {},
  repositories: {},
}));

vi.mock('@roomote/github', () => ({
  getInstallationOctokit: vi.fn(),
}));

import { buildGithubIssuePage } from '../brain-github';

const issue = {
  number: 42,
  title: 'Sandbox boots without the preview proxy',
  body: 'Steps to reproduce: launch a task with previews enabled.',
  state: 'closed',
  html_url: 'https://github.com/acme/widgets/issues/42',
  comments: 2,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-03T12:00:00Z',
  closed_at: '2026-08-03T12:00:00Z',
  user: { login: 'ada' },
  labels: ['bug', { name: 'previews' }],
};

describe('buildGithubIssuePage', () => {
  it('maps an issue with discussion into a slugged page', () => {
    const page = buildGithubIssuePage({
      fullName: 'acme/widgets',
      issue,
      comments: [
        {
          author: 'grace',
          body: 'Reproduced on the docker provider.',
          createdAt: '2026-08-02T09:00:00Z',
        },
      ],
    });

    expect(page?.slug).toBe('github/acme/widgets/issues/42');
    expect(page?.title).toBe(
      'acme/widgets#42: Sandbox boots without the preview proxy',
    );
    expect(page?.content).toContain('repository: acme/widgets');
    expect(page?.content).toContain('state: closed');
    expect(page?.content).toContain('labels: bug, previews');
    expect(page?.content).toContain('author: ada');
    expect(page?.content).toContain('provenance: roomote-github-issues');
    expect(page?.content).toContain('Steps to reproduce');
    expect(page?.content).toContain('## Discussion');
    expect(page?.content).toContain('**grace**');
    expect(page?.content).toContain('Reproduced on the docker provider.');
    expect(page?.content).toContain(
      'https://github.com/acme/widgets/issues/42',
    );
  });

  it('omits the discussion section when there are no comments', () => {
    const page = buildGithubIssuePage({
      fullName: 'acme/widgets',
      issue: { ...issue, comments: 0 },
      comments: [],
    });

    expect(page?.content).not.toContain('## Discussion');
  });

  it('caps long bodies and comment bodies', () => {
    const page = buildGithubIssuePage({
      fullName: 'acme/widgets',
      issue: { ...issue, body: 'x'.repeat(9000) },
      comments: [
        { author: 'ada', body: 'y'.repeat(9000), createdAt: '2026-08-02' },
      ],
    });

    expect(page?.content).toContain('x'.repeat(4000));
    expect(page?.content).not.toContain('x'.repeat(4001));
    expect(page?.content).toContain('y'.repeat(600));
    expect(page?.content).not.toContain('y'.repeat(601));
  });

  it('returns null for unusable payloads', () => {
    expect(
      buildGithubIssuePage({
        fullName: 'acme/widgets',
        issue: { number: 1, title: '' },
        comments: [],
      }),
    ).toBeNull();
  });
});
