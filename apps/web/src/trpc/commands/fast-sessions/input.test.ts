import {
  replyToFastSessionInputSchema,
  startFastSessionInputSchema,
} from './input';

describe('Fast session input schemas', () => {
  it('accepts image-only starts and replies', () => {
    const image = 'data:image/png;base64,aGVsbG8=';
    expect(
      startFastSessionInputSchema.parse({ text: '  ', images: [` ${image} `] }),
    ).toEqual({ text: '', images: [image] });
    expect(
      replyToFastSessionInputSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
        text: '',
        images: [image],
      }),
    ).toEqual({
      sessionId: '00000000-0000-4000-8000-000000000000',
      text: '',
      images: [image],
    });
  });

  it('rejects empty starts and replies without images', () => {
    expect(() => startFastSessionInputSchema.parse({ text: '  ' })).toThrow(
      'Text or at least one image is required',
    );
    expect(() =>
      replyToFastSessionInputSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
        text: '',
      }),
    ).toThrow('Text or at least one image is required');
  });

  it('rejects image values the Fast service cannot use', () => {
    expect(() =>
      startFastSessionInputSchema.parse({
        text: '',
        images: ['not-an-image'],
      }),
    ).toThrow('Image must be a base64 data URL');
  });
});
