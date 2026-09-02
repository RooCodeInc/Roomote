import {
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

  it('accepts deterministic artifact-build Session context', () => {
    expect(
      startFastSessionInputSchema.parse({
        text: 'Build the plan',
        artifactBuild: {
          launchId: '11111111-1111-4111-8111-111111111111',
          environmentId: '33333333-3333-4333-8333-333333333333',
          branch: 'feature/source-branch',
          taskModel: 'model-1',
          sourceArtifactId: '22222222-2222-4222-8222-222222222222',
          sourceArtifactPath: 'plans/widget.md',
          sourceArtifactVersion: 2,
        },
      }),
    ).toEqual({
      text: 'Build the plan',
      artifactBuild: {
        launchId: '11111111-1111-4111-8111-111111111111',
        environmentId: '33333333-3333-4333-8333-333333333333',
        branch: 'feature/source-branch',
        taskModel: 'model-1',
        sourceArtifactId: '22222222-2222-4222-8222-222222222222',
        sourceArtifactPath: 'plans/widget.md',
        sourceArtifactVersion: 2,
      },
    });
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
});
