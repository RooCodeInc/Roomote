import {
  buildPullRequestFilterValue,
  parsePullRequestFilterValue,
} from './pull-request-filter';

describe('pull request filter values', () => {
  it('round-trips provider-qualified pull request identities', () => {
    const value = buildPullRequestFilterValue({
      provider: 'gitlab',
      repository: 'owner/repository',
      number: 123,
    });

    expect(value).toBe('gitlab:owner/repository#123');
    expect(parsePullRequestFilterValue(value)).toEqual({
      provider: 'gitlab',
      repository: 'owner/repository',
      number: 123,
    });
  });

  it('prefers encoded hosts and falls back to repository IDs', () => {
    const repositoryIdentity = buildPullRequestFilterValue({
      provider: 'gitlab',
      repository: 'owner/repository',
      number: 123,
      repositoryId: '11111111-1111-4111-8111-111111111111',
      host: 'gitlab.example.com',
    });
    expect(parsePullRequestFilterValue(repositoryIdentity)).toEqual({
      provider: 'gitlab',
      repository: 'owner/repository',
      number: 123,
      host: 'gitlab.example.com',
    });

    const repositoryIdIdentity = buildPullRequestFilterValue({
      provider: 'gitea',
      repository: 'owner/repository',
      number: 123,
      repositoryId: '11111111-1111-4111-8111-111111111111',
    });
    expect(parsePullRequestFilterValue(repositoryIdIdentity)).toEqual({
      provider: 'gitea',
      repository: 'owner/repository',
      number: 123,
      repositoryId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('keeps legacy repository and number values readable', () => {
    expect(parsePullRequestFilterValue('owner/repository#123')).toEqual({
      provider: undefined,
      repository: 'owner/repository',
      number: 123,
    });
  });

  it.each([
    'github:#123',
    'github:owner/repository#0',
    'github:owner/repository#abc',
    'github:owner/repository',
    'github:owner/repository#123|unknown:value',
    'github:owner/repository#123|host:%E0%A4%A',
  ])('rejects invalid value %s', (value) => {
    expect(parsePullRequestFilterValue(value)).toBeNull();
  });
});
