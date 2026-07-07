import { buildSetupNewKickoffPrompt } from '../setup-new';

describe('setup-new prompt builder', () => {
  it('tells the setup task to use real services and ask for help when blocked', () => {
    const prompt = buildSetupNewKickoffPrompt(['acme/web', 'acme/api']);

    expect(prompt).toContain(
      'Do not mock or stub required services just to make the environment appear to work.',
    );
    expect(prompt).toContain(
      'If you cannot figure out how to get a required real service running, ask the user for help instead of inventing a fallback.',
    );
  });
});
