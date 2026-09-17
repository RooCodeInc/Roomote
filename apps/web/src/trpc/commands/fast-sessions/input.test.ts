import {
  fastSessionCapabilityOfferResponseInputSchema,
  replyToFastSessionInputSchema,
  startFastSessionInputSchema,
  updateFastSessionModelSelectionInputSchema,
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

  it('accepts bounded extracted attachment text', () => {
    expect(
      replyToFastSessionInputSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
        text: 'Implement this plan',
        attachmentTexts: ['Attachment: plan.md\nAdd the feature.'],
      }).attachmentTexts,
    ).toEqual(['Attachment: plan.md\nAdd the feature.']);
  });

  it('accepts a stable client conversation identity for initial retries', () => {
    expect(
      startFastSessionInputSchema.parse({
        text: 'Implement this plan',
        conversationId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toEqual({
      text: 'Implement this plan',
      conversationId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('accepts private mode only on Session creation', () => {
    expect(
      startFastSessionInputSchema.parse({
        text: 'Review private context',
        privacy: 'private',
      }),
    ).toEqual({ text: 'Review private context', privacy: 'private' });
    expect(
      replyToFastSessionInputSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
        text: 'Make this private',
        privacy: 'private',
      }),
    ).toEqual({
      sessionId: '00000000-0000-4000-8000-000000000000',
      text: 'Make this private',
    });
  });

  it('accepts private voice-call creation', () => {
    expect(
      startFastSessionInputSchema.parse({
        text: '',
        privacy: 'private',
        voiceCall: true,
      }),
    ).toEqual({ text: '', privacy: 'private', voiceCall: true });
  });

  it('rejects too many extracted attachments', () => {
    expect(() =>
      startFastSessionInputSchema.parse({
        text: 'Implement these plans',
        attachmentTexts: Array.from(
          { length: 21 },
          (_, index) => `Attachment ${index}`,
        ),
      }),
    ).toThrow('Array must contain at most 20 element(s)');
  });

  it('rejects extracted attachment text over the aggregate limit', () => {
    expect(() =>
      startFastSessionInputSchema.parse({
        text: 'Implement this plan',
        attachmentTexts: ['a'.repeat(200_001)],
      }),
    ).toThrow('Extracted attachment text exceeds the 200,000 character limit');
  });

  it('rejects empty starts and replies without images', () => {
    expect(() => startFastSessionInputSchema.parse({ text: '  ' })).toThrow(
      'Text or at least one attachment is required',
    );
    expect(() =>
      replyToFastSessionInputSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
        text: '',
      }),
    ).toThrow('Text or at least one attachment is required');
  });

  it('rejects image values the Fast service cannot use', () => {
    expect(() =>
      startFastSessionInputSchema.parse({
        text: '',
        images: ['not-an-image'],
      }),
    ).toThrow('Image must be a base64 data URL');
  });

  it('accepts explicit model-selection updates without message content', () => {
    expect(
      updateFastSessionModelSelectionInputSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
        model: ' openrouter/z-ai/glm-5.2 ',
        reasoningEffort: 'high',
      }),
    ).toEqual({
      sessionId: '00000000-0000-4000-8000-000000000000',
      model: 'openrouter/z-ai/glm-5.2',
      reasoningEffort: 'high',
    });
  });

  it('validates capability offer responses and bounds selected intent', () => {
    expect(
      fastSessionCapabilityOfferResponseInputSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
        offerId: 'cap:offer-1',
        capability: 'starter_work',
        resolution: 'completed',
        selectedIds: ['speed-up-ci'],
      }),
    ).toMatchObject({
      capability: 'starter_work',
      selectedIds: ['speed-up-ci'],
    });
    expect(() =>
      fastSessionCapabilityOfferResponseInputSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
        offerId: 'cap:offer-1',
        capability: 'credentials',
        resolution: 'completed',
      }),
    ).toThrow();
  });
});
