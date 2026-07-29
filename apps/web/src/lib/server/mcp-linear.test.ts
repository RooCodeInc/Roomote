import { getReplayLinearUserId } from './mcp-linear';

describe('getReplayLinearUserId', () => {
  it('uses the Linear user identity captured from the auth replay', () => {
    expect(
      getReplayLinearUserId({
        metadata: { linearUserId: 'linear-webhook-user' },
      } as never),
    ).toBe('linear-webhook-user');
  });

  it('ignores missing or malformed replay metadata', () => {
    expect(getReplayLinearUserId(undefined)).toBeUndefined();
    expect(
      getReplayLinearUserId({ metadata: { linearUserId: 123 } } as never),
    ).toBeUndefined();
  });
});
