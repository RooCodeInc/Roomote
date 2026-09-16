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
  ])('rejects invalid value %s', (value) => {
    expect(parsePullRequestFilterValue(value)).toBeNull();
  });
});
