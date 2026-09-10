import { eq } from 'drizzle-orm';

import { userFactory } from '../fixtures/factories/user.factory';
import { db } from '../db';
import { userPersonalizations } from '../schema';
import {
  appendLearnedUserPreference,
  getUserPersonalization,
  getUserPersonalizationRuntimeContext,
  updateUserPersonalization,
  UserPersonalizationConflictError,
} from './user-personalization';

describe('user personalization', () => {
  it('defaults learning on and isolates each owner', async () => {
    const [owner, other] = await Promise.all([
      userFactory.create(),
      userFactory.create(),
    ]);

    await updateUserPersonalization({
      userId: owner.id,
      expectedVersion: 0,
      instructions: 'Call me Ada.',
    });

    await expect(getUserPersonalization(owner.id)).resolves.toMatchObject({
      instructions: 'Call me Ada.',
      learnFromConversations: true,
      version: 1,
    });
    const stored = await db.query.userPersonalizations.findFirst({
      where: eq(userPersonalizations.userId, owner.id),
      columns: { manualInstructions: true },
    });
    expect(stored?.manualInstructions).not.toContain('Call me Ada.');
    await expect(getUserPersonalization(other.id)).resolves.toMatchObject({
      instructions: '',
      learnFromConversations: true,
      version: 0,
    });
  });

  it('rejects stale concurrent edits', async () => {
    const user = await userFactory.create();

    const results = await Promise.allSettled([
      updateUserPersonalization({
        userId: user.id,
        expectedVersion: 0,
        instructions: 'Be concise.',
      }),
      updateUserPersonalization({
        userId: user.id,
        expectedVersion: 0,
        instructions: 'Use examples.',
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.any(UserPersonalizationConflictError),
    });
  });

  it('enforces opt-out while keeping manual instructions active', async () => {
    const user = await userFactory.create();
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 0,
      instructions: 'Lead with the recommendation.',
      learnFromConversations: false,
    });

    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'Use pirate language.',
        confidence: 'explicit',
      }),
    ).resolves.toEqual({ saved: false, reason: 'disabled' });
    await expect(getUserPersonalization(user.id)).resolves.toMatchObject({
      instructions: 'Lead with the recommendation.',
      learnFromConversations: false,
    });
  });

  it('keeps manual text ahead of append-only conversational learning', async () => {
    const user = await userFactory.create();
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 0,
      instructions: 'Use a formal tone.',
    });
    await appendLearnedUserPreference({
      userId: user.id,
      preference: 'Prefer short answers.',
      confidence: 'explicit',
    });
    await appendLearnedUserPreference({
      userId: user.id,
      preference: 'Examples seem helpful.',
      confidence: 'inferred',
    });

    const settings = await getUserPersonalization(user.id);
    expect(settings.instructions).toBe(
      'Use a formal tone.\n- Prefer short answers.\n- Examples seem helpful.',
    );
  });

  it('reset clears every learned layer without changing the opt-out choice', async () => {
    const user = await userFactory.create();
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 0,
      instructions: 'Call me Ada.',
      learnFromConversations: false,
    });

    const reset = await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 1,
      reset: true,
    });

    expect(reset).toMatchObject({
      instructions: '',
      learnFromConversations: false,
      version: 2,
    });
    expect(reset.resetAt).toBeInstanceOf(Date);
    await expect(
      getUserPersonalizationRuntimeContext(user.id),
    ).resolves.toMatchObject({ displayName: null, instructions: '' });
    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'An old behavior pattern.',
        confidence: 'inferred',
      }),
    ).resolves.toEqual({ saved: false, reason: 'disabled' });
  });

  it('does not reconstruct inferred preferences across a reset boundary', async () => {
    const user = await userFactory.create();
    const initial = await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 0,
      instructions: 'Use examples.',
    });
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: initial.version,
      reset: true,
    });

    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'Use examples.',
        confidence: 'inferred',
      }),
    ).resolves.toEqual({ saved: false, reason: 'reset_boundary' });
  });
});
