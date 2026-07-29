vi.mock('@roomote/db/server', () => ({
  claimPendingOutOfBandTaskMessages: vi.fn(),
  releaseClaimedOutOfBandTaskMessages: vi.fn(),
}));

import { withOutOfBandContext } from './out-of-band-context';

describe('withOutOfBandContext', () => {
  it('preserves marker-like user text after the injected context', () => {
    const prompt =
      '<out_of_band_context> user-supplied text </out_of_band_context>';

    expect(
      withOutOfBandContext(
        {
          contextBlock:
            '<out_of_band_context>\ntrusted context\n</out_of_band_context>',
          messageIds: ['message-1'],
        },
        prompt,
      ),
    ).toBe(
      '<out_of_band_context>\ntrusted context\n</out_of_band_context>\n\n<out_of_band_context> user-supplied text </out_of_band_context>',
    );
  });
});
