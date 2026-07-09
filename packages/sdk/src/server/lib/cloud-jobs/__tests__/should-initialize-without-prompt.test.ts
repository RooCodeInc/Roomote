import { TaskPayloadKind, standardTaskSchema } from '@roomote/types';
import { shouldInitializeWithoutPrompt } from '../dequeue-cloud-job';

// Minimal shared fields required by all CloudTask variants.
const sharedFields = {
  userId: 'user_123',
};

describe('shouldInitializeWithoutPrompt', () => {
  it('returns false when description is a non-empty string', () => {
    const task = standardTaskSchema.parse({
      ...sharedFields,
      type: TaskPayloadKind.StandardTask,
      payload: { repo: 'owner/repo', description: 'Fix the bug' },
    });

    expect(shouldInitializeWithoutPrompt(task)).toBe(false);
  });

  it('returns true when description is an empty string', () => {
    const task = standardTaskSchema.parse({
      ...sharedFields,
      type: TaskPayloadKind.StandardTask,
      payload: { repo: 'owner/repo', description: '' },
    });

    expect(shouldInitializeWithoutPrompt(task)).toBe(true);
  });

  it('returns true when description is undefined and blank is true (Zod strips key)', () => {
    const task = standardTaskSchema.parse({
      ...sharedFields,
      type: TaskPayloadKind.StandardTask,
      payload: { repo: 'owner/repo', description: undefined, blank: true },
    });

    // After Zod parsing, description key is stripped (optional + undefined).
    // The function should still detect this as a blank task via the blank flag.
    expect(shouldInitializeWithoutPrompt(task)).toBe(true);
  });

  it('returns true when description is omitted and blank is true', () => {
    const task = standardTaskSchema.parse({
      ...sharedFields,
      type: TaskPayloadKind.StandardTask,
      payload: { repo: 'owner/repo', blank: true },
    });

    expect(shouldInitializeWithoutPrompt(task)).toBe(true);
  });

  it('returns false when description is omitted and blank is not set', () => {
    const task = standardTaskSchema.parse({
      ...sharedFields,
      type: TaskPayloadKind.StandardTask,
      payload: { repo: 'owner/repo' },
    });

    expect(shouldInitializeWithoutPrompt(task)).toBe(false);
  });

  it('returns true when description is whitespace-only', () => {
    const task = standardTaskSchema.parse({
      ...sharedFields,
      type: TaskPayloadKind.StandardTask,
      payload: { repo: 'owner/repo', description: '   ' },
    });

    expect(shouldInitializeWithoutPrompt(task)).toBe(true);
  });
});
