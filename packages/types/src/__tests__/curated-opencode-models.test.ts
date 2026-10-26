import { mergeCuratedOpenCodeModelConfig } from '../curated-opencode-models';

describe('mergeCuratedOpenCodeModelConfig', () => {
  it('leaves unrelated models and providers unchanged', () => {
    const config = { azure: { options: { resourceName: 'example' } } };
    expect(
      mergeCuratedOpenCodeModelConfig(config, [
        undefined,
        'openai/gpt-6.1-sol',
      ]),
    ).toBe(config);
  });

  it('fills model defaults without mutating options, SDKs or explicit limits', () => {
    const config = {
      azure: {
        npm: '@ai-sdk/azure',
        options: { baseURL: 'https://example.test/v1' },
        models: {
          'gpt-6.1-terra': {
            name: 'Custom Terra',
            limit: { output: 16_384 },
            modalities: { input: ['text'] },
            options: { reasoningEffort: 'high' },
          },
          other: { name: 'Other' },
        },
      },
    };
    const before = structuredClone(config);
    const merged = mergeCuratedOpenCodeModelConfig(config, [
      ' azure/gpt-6.1-terra ',
      'azure/gpt-6.1-terra',
    ]);
    expect(merged).toMatchObject({
      azure: {
        npm: '@ai-sdk/azure',
        options: { baseURL: 'https://example.test/v1' },
        models: {
          'gpt-6.1-terra': {
            name: 'Custom Terra',
            reasoning: true,
            tool_call: true,
            attachment: true,
            limit: { context: 1_050_000, input: 922_000, output: 16_384 },
            modalities: { input: ['text'], output: ['text'] },
            options: { reasoningEffort: 'high' },
          },
          other: { name: 'Other' },
        },
      },
    });
    expect(config).toEqual(before);
    expect(
      mergeCuratedOpenCodeModelConfig(merged, ['azure/gpt-6.1-terra']),
    ).toEqual(merged);
  });
});
