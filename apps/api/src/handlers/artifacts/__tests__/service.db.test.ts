import { db, taskArtifacts, taskFactory } from '@roomote/db/server';

import { getArtifactByPath } from '../service';

describe('getArtifactByPath', () => {
  let taskId: string;
  const path = 'reports/result.pdf';

  beforeEach(async () => {
    taskId = (await taskFactory.create()).id;
    await db.insert(taskArtifacts).values(
      [1, 2, 3].map((version) => ({
        taskId,
        path,
        version,
        uploaded: version < 3,
        contentType: 'application/pdf',
        size: 100,
      })),
    );
  });

  it('returns the latest uploaded version when a newer upload is incomplete', async () => {
    await expect(
      getArtifactByPath({ taskId, path, auth: {} }),
    ).resolves.toMatchObject({ taskId, path, version: 2, uploaded: true });
  });

  it('retains exact version lookups, including incomplete upload metadata', async () => {
    for (const version of [1, 2, 3]) {
      await expect(
        getArtifactByPath({ taskId, path, version, auth: {} }),
      ).resolves.toMatchObject({
        taskId,
        path,
        version,
        uploaded: version < 3,
      });
    }
    await expect(
      getArtifactByPath({ taskId, path, version: 4, auth: {} }),
    ).resolves.toBeNull();
  });

  it('returns no latest artifact when every version is incomplete', async () => {
    const incompletePath = 'reports/incomplete.pdf';
    await db.insert(taskArtifacts).values(
      [1, 2].map((version) => ({
        taskId,
        path: incompletePath,
        version,
        uploaded: false,
        contentType: 'application/pdf',
        size: 100,
      })),
    );

    await expect(
      getArtifactByPath({ taskId, path: incompletePath, auth: {} }),
    ).resolves.toBeNull();
  });
});
