import { db } from '../db';
import { sessionFactory } from '../fixtures/factories/session.factory';
import { taskFactory } from '../fixtures/factories/task.factory';
import { taskArtifacts } from '../schema';
import {
  getSessionArtifactByPath,
  getTaskArtifactByPath,
  listLatestTaskArtifacts,
} from './artifacts';

describe('listLatestTaskArtifacts', () => {
  it('returns only the latest uploaded version per path from a large history', async () => {
    const task = await taskFactory.create();
    const firstCreatedAt = new Date('2026-01-01T00:00:00.000Z');
    const secondCreatedAt = new Date('2026-01-02T00:00:00.000Z');

    await db.insert(taskArtifacts).values([
      ...Array.from({ length: 250 }, (_, version) => ({
        taskId: task.id,
        path: 'reports/repeated.md',
        version,
        uploaded: true,
        artifactType: 'general',
        contentType: 'text/markdown',
        size: version + 1,
        createdAt:
          version === 0
            ? firstCreatedAt
            : new Date(secondCreatedAt.getTime() + version * 1_000),
      })),
      {
        taskId: task.id,
        path: 'reports/other.md',
        version: 0,
        uploaded: true,
        artifactType: 'general',
        contentType: 'text/markdown',
        size: 10,
        createdAt: secondCreatedAt,
      },
      {
        taskId: task.id,
        path: 'reports/repeated.md',
        version: 250,
        uploaded: false,
        artifactType: 'general',
        contentType: 'text/markdown',
        size: 251,
      },
    ]);

    const artifacts = await listLatestTaskArtifacts({ taskId: task.id });

    expect(artifacts).toHaveLength(2);
    expect(artifacts.map(({ path, version }) => ({ path, version }))).toEqual([
      { path: 'reports/repeated.md', version: 249 },
      { path: 'reports/other.md', version: 0 },
    ]);
  });

  it('applies the artifact type filter before selecting the latest version', async () => {
    const task = await taskFactory.create();
    await db.insert(taskArtifacts).values([
      {
        taskId: task.id,
        path: 'report.md',
        version: 0,
        uploaded: true,
        artifactType: 'general',
        contentType: 'text/markdown',
        size: 10,
      },
      {
        taskId: task.id,
        path: 'report.md',
        version: 1,
        uploaded: true,
        artifactType: 'visual-proof',
        contentType: 'text/markdown',
        size: 20,
      },
    ]);

    await expect(
      listLatestTaskArtifacts({
        taskId: task.id,
        artifactType: 'general',
      }),
    ).resolves.toMatchObject([{ path: 'report.md', version: 0 }]);
  });
});

describe.each(['task', 'session'] as const)(
  '%s artifact path lookup',
  (scope) => {
    let ownerId: string;
    const path = 'reports/result.pdf';

    function lookup(artifactPath = path, version?: number, id = ownerId) {
      return scope === 'task'
        ? getTaskArtifactByPath({ taskId: id, path: artifactPath, version })
        : getSessionArtifactByPath({
            sessionId: id,
            path: artifactPath,
            version,
          });
    }

    beforeEach(async () => {
      ownerId =
        scope === 'task'
          ? (await taskFactory.create()).id
          : (await sessionFactory.create()).id;
      const owner =
        scope === 'task' ? { taskId: ownerId } : { sessionId: ownerId };
      await db.insert(taskArtifacts).values(
        [1, 2, 3].map((version) => ({
          ...owner,
          path,
          version,
          uploaded: version < 3,
          contentType: 'application/pdf',
          size: 100,
        })),
      );
    });

    it('returns the latest successful upload despite an interrupted replacement', async () => {
      const artifact = await lookup();
      expect(artifact).toMatchObject({ path, version: 2, uploaded: true });
      if (scope === 'task') {
        expect(artifact).toMatchObject({
          taskId: ownerId,
          sessionId: null,
          task: { id: ownerId },
        });
      } else {
        expect(artifact).toMatchObject({ taskId: null, sessionId: ownerId });
        expect(artifact).not.toHaveProperty('task');
      }
    });

    it('returns exact versions including incomplete metadata, and null for absent versions', async () => {
      for (const version of [1, 2, 3]) {
        await expect(lookup(path, version)).resolves.toMatchObject({
          version,
          uploaded: version < 3,
        });
      }
      await expect(lookup(path, 4)).resolves.toBeNull();
      await expect(lookup(path, 0)).resolves.toBeNull();
    });

    it('returns null for missing paths and paths with only incomplete uploads', async () => {
      const incompletePath = 'reports/incomplete.pdf';
      await db.insert(taskArtifacts).values({
        ...(scope === 'task' ? { taskId: ownerId } : { sessionId: ownerId }),
        path: incompletePath,
        uploaded: false,
        contentType: 'application/pdf',
        size: 100,
      });
      await expect(lookup(incompletePath)).resolves.toBeNull();
      await expect(lookup('missing.pdf')).resolves.toBeNull();
      await expect(lookup('missing.pdf', 1)).resolves.toBeNull();
    });

    it('isolates both latest and explicit reads by owner and owner kind', async () => {
      const otherTask = await taskFactory.create();
      const otherSession = await sessionFactory.create();
      await db.insert(taskArtifacts).values([
        {
          taskId: otherTask.id,
          path,
          version: 10,
          uploaded: true,
          contentType: 'application/pdf',
          size: 100,
        },
        {
          sessionId: otherSession.id,
          path,
          version: 10,
          uploaded: true,
          contentType: 'application/pdf',
          size: 100,
        },
      ]);
      await expect(lookup()).resolves.toMatchObject({ version: 2 });
      await expect(lookup(path, 10)).resolves.toBeNull();
      const otherOwnerId = scope === 'task' ? otherTask.id : otherSession.id;
      await expect(
        lookup(path, undefined, otherOwnerId),
      ).resolves.toMatchObject({ version: 10 });
      await expect(lookup(path, 10, otherOwnerId)).resolves.toMatchObject({
        version: 10,
      });
      const emptyOwnerId =
        scope === 'task'
          ? (await taskFactory.create()).id
          : (await sessionFactory.create()).id;
      await expect(lookup(path, undefined, emptyOwnerId)).resolves.toBeNull();
      await expect(lookup(path, 1, emptyOwnerId)).resolves.toBeNull();
    });
  },
);
