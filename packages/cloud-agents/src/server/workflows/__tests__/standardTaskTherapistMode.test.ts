import { standardTask } from '../standardTask';

describe('standardTask therapist mode', () => {
  const baseInput = {
    description: 'Use relevant context to answer the request.',
    repo: 'RooCodeInc/Roomote',
  };

  it('adds safe memory disclosure guidance when enabled', () => {
    const { harnessInstructions } = standardTask({
      ...baseInput,
      therapistModeEnabled: true,
    });

    expect(harnessInstructions).toContain('<therapist_mode>');
    expect(harnessInstructions).toContain(
      'which remembered fact you retrieved and how you used it',
    );
    expect(harnessInstructions).toContain(
      'Never expose internal memory IDs, page slugs, storage paths, raw metadata, source fields, or other internal provenance',
    );
  });

  it('preserves the current silent behavior when disabled', () => {
    const { harnessInstructions } = standardTask(baseInput);

    expect(harnessInstructions).not.toContain('<therapist_mode>');
    expect(harnessInstructions).not.toContain(
      'which remembered fact you retrieved and how you used it',
    );
  });
});
