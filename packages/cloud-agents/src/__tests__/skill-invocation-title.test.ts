import { stripRecognizedInitialSkillInvocationsForTitle } from '../skill-invocation-title';

describe('stripRecognizedInitialSkillInvocationsForTitle', () => {
  it('removes repeated leading packaged skill invocations', () => {
    expect(
      stripRecognizedInitialSkillInvocationsForTitle(
        '$implement-changes /review-code\n\nFix the task title',
      ),
    ).toBe('Fix the task title');
  });

  it.each([
    ['/review-code: Fix the task', 'Fix the task'],
    ['$review-code, Fix the task', 'Fix the task'],
  ])('recognizes punctuation-delimited invocations: %s', (prompt, title) => {
    expect(stripRecognizedInitialSkillInvocationsForTitle(prompt)).toBe(title);
  });

  it.each([
    '$not-a-real-skill Fix the task',
    '$doctor Fix the task',
    'Estimate $100 for the task',
    'Explain $implement-changes in the task',
  ])('preserves ordinary or unresolved dollar text: %s', (title) => {
    expect(stripRecognizedInitialSkillInvocationsForTitle(title)).toBe(title);
  });

  it('stops after removing a recognized prefix when the next token is unresolved', () => {
    expect(
      stripRecognizedInitialSkillInvocationsForTitle(
        '$implement-changes $not-a-real-skill Fix the task',
      ),
    ).toBe('$not-a-real-skill Fix the task');
  });

  it('returns an empty title for a recognized invocation without a request body', () => {
    expect(
      stripRecognizedInitialSkillInvocationsForTitle('$implement-changes'),
    ).toBe('');
  });
});
