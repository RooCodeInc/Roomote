import { eq } from 'drizzle-orm';

import { userFactory } from '../fixtures/factories/user.factory';
import { db } from '../db';
import {
  fastAgentConversations,
  fastAgentPersonalizationSnapshots,
  userPersonalizations,
} from '../schema';
import {
  appendLearnedUserPreference,
  getOrCreateFastAgentPersonalizationSnapshot,
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

  it('uses the frozen Fast conversation learning setting for later updates', async () => {
    const user = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: 'personalization-learning-snapshot-test',
        conversationId: crypto.randomUUID(),
      })
      .returning({ id: fastAgentConversations.id });
    await getOrCreateFastAgentPersonalizationSnapshot({
      conversationId: conversation!.id,
      userId: user.id,
    });
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 0,
      learnFromConversations: false,
    });

    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'Save this for my next conversation.',
        confidence: 'explicit',
        fastConversationId: conversation!.id,
      }),
    ).resolves.toEqual({ saved: true });
    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'Do not save without a frozen enabled snapshot.',
        confidence: 'explicit',
      }),
    ).resolves.toEqual({ saved: false, reason: 'disabled' });

    const [disabledConversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: 'personalization-disabled-snapshot-test',
        conversationId: crypto.randomUUID(),
      })
      .returning({ id: fastAgentConversations.id });
    await getOrCreateFastAgentPersonalizationSnapshot({
      conversationId: disabledConversation!.id,
      userId: user.id,
    });
    const current = await getUserPersonalization(user.id);
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: current.version,
      learnFromConversations: true,
    });
    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'Do not save from a frozen disabled conversation.',
        confidence: 'explicit',
        fastConversationId: disabledConversation!.id,
      }),
    ).resolves.toEqual({ saved: false, reason: 'disabled' });
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

  it('removes superseded preferences before adding an explicit correction', async () => {
    const user = await userFactory.create();
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 0,
      instructions: 'Use pirate language.',
    });
    await appendLearnedUserPreference({
      userId: user.id,
      preference: 'Keep answers short.',
      confidence: 'explicit',
    });

    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'Use normal professional language.',
        confidence: 'explicit',
        supersedes: ['Use pirate language.', 'Keep answers short.'],
      }),
    ).resolves.toEqual({ saved: true });

    await expect(getUserPersonalization(user.id)).resolves.toMatchObject({
      instructions: '- Use normal professional language.',
    });
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

    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'Prefer concise answers.',
        confidence: 'explicit',
      }),
    ).resolves.toEqual({ saved: true });
    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'Examples appear helpful again.',
        confidence: 'inferred',
      }),
    ).resolves.toEqual({ saved: true });
    await expect(
      getUserPersonalizationRuntimeContext(user.id),
    ).resolves.toMatchObject({ displayName: user.name });
  });

  it('lets a manual save explicitly restart learning after reset', async () => {
    const user = await userFactory.create();
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 0,
      reset: true,
    });
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 1,
      instructions: 'Use concrete examples.',
    });

    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'Prefer short progress updates.',
        confidence: 'inferred',
      }),
    ).resolves.toEqual({ saved: true });
  });

  it('lets an explicit learning re-enable restart inference after reset', async () => {
    const user = await userFactory.create();
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 0,
      reset: true,
    });
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 1,
      learnFromConversations: false,
    });
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 2,
      learnFromConversations: true,
    });

    await expect(
      appendLearnedUserPreference({
        userId: user.id,
        preference: 'Prefer short progress updates.',
        confidence: 'inferred',
      }),
    ).resolves.toEqual({ saved: true });
  });

  it('freezes personalization per Fast conversation while later conversations use updated or reset settings', async () => {
    const user = await userFactory.create({ name: 'Ada' });
    const [firstConversation, secondConversation, thirdConversation] = await db
      .insert(fastAgentConversations)
      .values([
        {
          userId: user.id,
          surface: 'web',
          workspaceId: 'personalization-snapshot-test',
          conversationId: crypto.randomUUID(),
        },
        {
          userId: user.id,
          surface: 'web',
          workspaceId: 'personalization-snapshot-test',
          conversationId: crypto.randomUUID(),
        },
        {
          userId: user.id,
          surface: 'web',
          workspaceId: 'personalization-snapshot-test',
          conversationId: crypto.randomUUID(),
        },
      ])
      .returning({ id: fastAgentConversations.id });
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 0,
      instructions: 'Prefer detailed answers.',
    });

    const first = await getOrCreateFastAgentPersonalizationSnapshot({
      conversationId: firstConversation!.id,
      userId: user.id,
    });
    await appendLearnedUserPreference({
      userId: user.id,
      preference: 'Prefer concise answers.',
      confidence: 'explicit',
      supersedes: ['Prefer detailed answers.'],
    });

    await expect(
      getOrCreateFastAgentPersonalizationSnapshot({
        conversationId: firstConversation!.id,
        userId: user.id,
      }),
    ).resolves.toEqual(first);
    await expect(
      getOrCreateFastAgentPersonalizationSnapshot({
        conversationId: secondConversation!.id,
        userId: user.id,
      }),
    ).resolves.toMatchObject({
      displayName: 'Ada',
      instructions: expect.stringContaining('Prefer concise answers.'),
    });
    await updateUserPersonalization({
      userId: user.id,
      expectedVersion: 2,
      reset: true,
    });
    await expect(
      getOrCreateFastAgentPersonalizationSnapshot({
        conversationId: firstConversation!.id,
        userId: user.id,
      }),
    ).resolves.toEqual(first);
    await expect(
      getOrCreateFastAgentPersonalizationSnapshot({
        conversationId: secondConversation!.id,
        userId: user.id,
      }),
    ).resolves.toMatchObject({
      displayName: 'Ada',
      instructions: expect.stringContaining('Prefer concise answers.'),
    });
    await expect(
      getOrCreateFastAgentPersonalizationSnapshot({
        conversationId: thirdConversation!.id,
        userId: user.id,
      }),
    ).resolves.toEqual({
      displayName: null,
      instructions: '',
      learnFromConversations: true,
    });
  });

  it('keeps encrypted participant snapshots isolated within a Fast conversation', async () => {
    const [owner, participant] = await Promise.all([
      userFactory.create({ name: 'Ada' }),
      userFactory.create({ name: 'Grace' }),
    ]);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        surface: 'slack',
        workspaceId: 'personalization-participant-test',
        conversationId: crypto.randomUUID(),
      })
      .returning({ id: fastAgentConversations.id });
    await Promise.all([
      updateUserPersonalization({
        userId: owner.id,
        expectedVersion: 0,
        instructions: 'OWNER_PRIVATE_SENTINEL',
      }),
      updateUserPersonalization({
        userId: participant.id,
        expectedVersion: 0,
        instructions: 'PARTICIPANT_PRIVATE_SENTINEL',
      }),
    ]);

    const [ownerSnapshot, participantSnapshot] = await Promise.all([
      getOrCreateFastAgentPersonalizationSnapshot({
        conversationId: conversation!.id,
        userId: owner.id,
      }),
      getOrCreateFastAgentPersonalizationSnapshot({
        conversationId: conversation!.id,
        userId: participant.id,
      }),
    ]);

    expect(ownerSnapshot?.instructions).toContain('OWNER_PRIVATE_SENTINEL');
    expect(ownerSnapshot?.instructions).not.toContain(
      'PARTICIPANT_PRIVATE_SENTINEL',
    );
    expect(participantSnapshot?.instructions).toContain(
      'PARTICIPANT_PRIVATE_SENTINEL',
    );
    expect(participantSnapshot?.instructions).not.toContain(
      'OWNER_PRIVATE_SENTINEL',
    );
    const stored = await db
      .select({
        displayName: fastAgentPersonalizationSnapshots.displayName,
        instructions: fastAgentPersonalizationSnapshots.instructions,
      })
      .from(fastAgentPersonalizationSnapshots)
      .where(
        eq(fastAgentPersonalizationSnapshots.conversationId, conversation!.id),
      );
    expect(JSON.stringify(stored)).not.toContain('PRIVATE_SENTINEL');
  });
});
