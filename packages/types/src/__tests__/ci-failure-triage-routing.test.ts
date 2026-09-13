import {
  getCiFailureTriageRules,
  isCiFailureTriageRepositoryAllowed,
  ciFailureTriageRulesSchema,
} from '../ci-failure-triage-routing';

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const rules = {
  text: 'Only backend',
  repositoryIds: [id],
  destinations: [],
  instructions: '',
};
describe('CI additional rules policy', () => {
  it('preserves the shipped default with no rules', () => {
    expect(getCiFailureTriageRules({})).toBeUndefined();
    expect(isCiFailureTriageRepositoryAllowed({}, other)).toBe(true);
  });
  it.each([
    {},
    { compiledRules: null },
    { compiledRules: { ...rules, text: 'different' } },
    { compiledRules: { ...rules, repositoryIds: 'all' } },
  ])(
    'fails closed for missing, malformed or mismatched compilation %j',
    (settings) => {
      const saved = { additionalRules: rules.text, ...settings };
      expect(getCiFailureTriageRules(saved)).toBeNull();
      expect(isCiFailureTriageRepositoryAllowed(saved, id)).toBe(false);
    },
  );
  it('enforces finite scope and permits all with destination-only rules', () => {
    const saved = { additionalRules: rules.text, compiledRules: rules };
    expect(isCiFailureTriageRepositoryAllowed(saved, id)).toBe(true);
    expect(isCiFailureTriageRepositoryAllowed(saved, other)).toBe(false);
    expect(
      isCiFailureTriageRepositoryAllowed(
        { ...saved, compiledRules: { ...rules, repositoryIds: null } },
        other,
      ),
    ).toBe(true);
  });
  it('rejects duplicates and out-of-scope destinations', () => {
    expect(
      ciFailureTriageRulesSchema.safeParse({
        ...rules,
        repositoryIds: [id, id],
      }).success,
    ).toBe(false);
    expect(
      ciFailureTriageRulesSchema.safeParse({
        ...rules,
        destinations: [
          {
            repositoryId: other,
            target: { provider: 'slack', externalRef: 'C1', workspaceId: 'T1' },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('an empty compiled scope does not mean all', () => {
    expect(
      isCiFailureTriageRepositoryAllowed(
        {
          additionalRules: rules.text,
          compiledRules: { ...rules, repositoryIds: [] },
        },
        id,
      ),
    ).toBe(false);
  });
});
