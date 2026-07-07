import type { CloudTask } from '@roomote/types';
import { CloudTaskType } from '@roomote/types';

import { db, inArray, userFactory, users } from '../server';

import {
  buildTaskAttributionSnapshot,
  resolveTaskAttributionDisplay,
} from './task-attribution';

describe('resolveTaskAttributionDisplay', () => {
  it('keeps unnamed unlinked creators distinct from automatic Roomote tasks', () => {
    expect(
      resolveTaskAttributionDisplay({
        attributionKind: 'unlinked_user',
        attributedUserId: null,
        attributionSourceKind: 'slack',
        attributionSourceDisplayName: null,
        attributionSourceExternalId: 'U123',
        attributedGithubLogin: null,
        attributedGithubUserId: null,
      }),
    ).toMatchObject({
      kind: 'unlinked_user',
      productDisplay: 'U123',
      analyticsDisplay: 'U123',
    });

    expect(
      resolveTaskAttributionDisplay({
        attributionKind: 'unlinked_user',
        attributedUserId: null,
        attributionSourceKind: 'github',
        attributionSourceDisplayName: null,
        attributionSourceExternalId: null,
        attributedGithubLogin: null,
        attributedGithubUserId: null,
      }),
    ).toMatchObject({
      kind: 'unlinked_user',
      productDisplay: 'Unlinked GitHub user',
      analyticsDisplay: 'Unlinked GitHub user',
    });

    expect(
      resolveTaskAttributionDisplay({
        attributionKind: 'unlinked_user',
        attributedUserId: null,
        attributionSourceKind: 'ado',
        attributionSourceDisplayName: null,
        attributionSourceExternalId: null,
        attributedGithubLogin: null,
        attributedGithubUserId: null,
      }),
    ).toMatchObject({
      kind: 'unlinked_user',
      productDisplay: 'Unlinked Azure DevOps user',
      analyticsDisplay: 'Unlinked Azure DevOps user',
    });
  });

  it.each([
    {
      caseName: 'prefers the trimmed attributed user name',
      attributedUser: { name: '  Casey Example  ', email: 'casey@example.com' },
      expected: 'Casey Example',
    },
    {
      caseName:
        'falls back to the attributed user email local-part when the name is blank',
      attributedUser: { name: '   ', email: 'casey@example.com' },
      expected: 'casey',
    },
  ])(
    'uses the shared display-name helper when it $caseName',
    ({ attributedUser, expected }) => {
      expect(
        resolveTaskAttributionDisplay(
          {
            attributionKind: 'matched_user',
            attributedUserId: 'user-1',
            attributionSourceKind: 'web',
            attributionSourceDisplayName: null,
            attributionSourceExternalId: null,
            attributedGithubLogin: null,
            attributedGithubUserId: null,
          },
          { attributedUser },
        ),
      ).toMatchObject({
        githubDisplay: expected,
        productDisplay: expected,
        analyticsDisplay: expected,
      });
    },
  );
});

describe('buildTaskAttributionSnapshot', () => {
  const createdUserIds: string[] = [];

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }

    createdUserIds.length = 0;
  });

  it('attributes SnapshotResume launches to the explicit Roomote user when present', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);

    const snapshot = await buildTaskAttributionSnapshot(db, {
      userId: user.id,
      type: CloudTaskType.SnapshotResume,
      slackThreadTs: '1717430000.000200',
      payload: {
        repo: 'owner/repo',
        sourceSnapshotId: 'snapshot-1',
        sourceCloudJobId: 123,
        channel: 'C123',
        thread_ts: '1717430000.000100',
        slackOriginMessageTs: '1717430000.000200',
      },
    } satisfies CloudTask);

    expect(snapshot).toMatchObject({
      attributionKind: 'matched_user',
      attributedUserId: user.id,
      attributionSourceKind: 'slack',
    });
  });

  it('prefers SnapshotResume resumePromptUserId over the original task owner', async () => {
    const originalOwner = await userFactory.create();
    const resumeUser = await userFactory.create();
    createdUserIds.push(originalOwner.id, resumeUser.id);

    const snapshot = await buildTaskAttributionSnapshot(db, {
      userId: originalOwner.id,
      type: CloudTaskType.SnapshotResume,
      payload: {
        repo: 'owner/repo',
        sourceSnapshotId: 'snapshot-1',
        sourceCloudJobId: 123,
        resumePrompt: 'Please continue',
        resumePromptSource: 'web',
        resumePromptUserId: resumeUser.id,
      },
    } satisfies CloudTask);

    expect(snapshot).toMatchObject({
      attributionKind: 'matched_user',
      attributedUserId: resumeUser.id,
      attributionSourceKind: 'web',
    });
  });

  it('treats SnapshotResume launches with only resumePromptUserId as human follow-ups', async () => {
    const resumeUser = await userFactory.create();
    createdUserIds.push(resumeUser.id);

    const snapshot = await buildTaskAttributionSnapshot(db, {
      userId: null,
      type: CloudTaskType.SnapshotResume,
      payload: {
        repo: 'owner/repo',
        sourceSnapshotId: 'snapshot-1',
        sourceCloudJobId: 123,
        resumePrompt: 'Please continue',
        resumePromptSource: 'github',
        resumePromptUserId: resumeUser.id,
      },
    } satisfies CloudTask);

    expect(snapshot).toMatchObject({
      attributionKind: 'matched_user',
      attributedUserId: resumeUser.id,
      attributionSourceKind: 'web',
    });
  });

  it('keeps SnapshotResume automatic when no explicit Roomote user is available', async () => {
    const snapshot = await buildTaskAttributionSnapshot(db, {
      userId: null,
      type: CloudTaskType.SnapshotResume,
      slackThreadTs: '1717430000.000200',
      payload: {
        repo: 'owner/repo',
        sourceSnapshotId: 'snapshot-1',
        sourceCloudJobId: 123,
        channel: 'C123',
        thread_ts: '1717430000.000100',
        slackOriginMessageTs: '1717430000.000200',
      },
    } satisfies CloudTask);

    expect(snapshot).toMatchObject({
      attributionKind: 'automatic',
      attributedUserId: null,
      attributionSourceKind: 'slack',
    });
  });

  it('preserves the raw GitHub login and numeric user ID for unlinked GitHub creators', async () => {
    const snapshot = await buildTaskAttributionSnapshot(db, {
      userId: null,
      type: CloudTaskType.StandardTask,
      githubLogin: 'octocat',
      githubUserId: 12345,
      payload: {
        repo: 'owner/repo',
      },
    } satisfies CloudTask);

    expect(snapshot).toMatchObject({
      attributionKind: 'unlinked_user',
      attributedUserId: null,
      attributionSourceKind: 'github',
      attributedGithubLogin: 'octocat',
      attributedGithubUserId: 12345,
    });
  });
});
