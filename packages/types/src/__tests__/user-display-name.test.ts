import { getUserDisplayName } from '../user-display-name';

describe('getUserDisplayName', () => {
  it.each([
    {
      caseName: 'prefers a trimmed name when present',
      user: { name: '  Casey Example  ', email: 'casey@example.com' },
      expected: 'Casey Example',
    },
    {
      caseName: 'falls back to the email local-part when the name is blank',
      user: { name: '   ', email: 'casey@example.com' },
      expected: 'casey',
    },
    {
      caseName: 'returns null when neither name nor email is usable',
      user: { name: '   ', email: '   ' },
      expected: null,
    },
  ])('$caseName', ({ user, expected }) => {
    expect(getUserDisplayName(user)).toBe(expected);
  });
});
