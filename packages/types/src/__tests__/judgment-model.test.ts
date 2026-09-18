import { resolveEffectiveJudgmentModelSelection } from '../judgment-model';

describe('resolveEffectiveJudgmentModelSelection', () => {
  it.each([
    [{ hasTypeSafeKey: false }, 'off'],
    [{ hasTypeSafeKey: true }, 'typesafe'],
    [{ storedSelection: 'off', hasTypeSafeKey: true }, 'off'],
    [{ storedSelection: 'openrouter', hasTypeSafeKey: false }, 'openrouter'],
    [{ storedSelection: 'vercel', hasTypeSafeKey: true }, 'vercel'],
    [
      {
        envSelection: 'typesafe',
        storedSelection: 'off',
        hasTypeSafeKey: false,
      },
      'typesafe',
    ],
    [
      {
        envSelection: 'openrouter',
        storedSelection: 'off',
        hasTypeSafeKey: false,
      },
      'openrouter',
    ],
    [
      {
        envSelection: 'bogus',
        storedSelection: 'vercel',
        hasTypeSafeKey: false,
      },
      'vercel',
    ],
  ] as const)('%o resolves to %s', (params, expected) => {
    expect(resolveEffectiveJudgmentModelSelection(params)).toBe(expected);
  });
});
