const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class PutObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  },
  S3Client: class S3Client {
    send = mocks.send;
  },
}));

import {
  db,
  eq,
  sessionFactory,
  taskArtifacts,
  userFactory,
} from '@roomote/db/server';

import { createSessionArtifact } from '../create-session-artifact';

describe('createSessionArtifact', () => {
  beforeEach(() => {
    mocks.send.mockReset().mockResolvedValue({ ETag: 'etag' });
  });

  it('stores uploaded versions against the Session without a task owner', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });

    const first = await createSessionArtifact({
      sessionId: session.id,
      path: 'notes/result.md',
      content: '# Result',
      contentType: 'text/markdown',
      artifactType: 'general',
    });
    const second = await createSessionArtifact({
      sessionId: session.id,
      path: 'notes/result.md',
      content: '# Updated result',
      contentType: 'text/markdown',
      artifactType: 'general',
    });

    expect([first.version, second.version]).toEqual([1, 2]);
    expect(first).toMatchObject({
      taskId: null,
      sessionId: session.id,
      uploaded: true,
    });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Key: `sessions/${session.id}/artifacts/${first.id}/v1/notes/result.md`,
      },
    });
    const rows = await db
      .select()
      .from(taskArtifacts)
      .where(eq(taskArtifacts.sessionId, session.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.taskId === null && row.uploaded)).toBe(true);
  });

  it('leaves an incomplete row hidden when object storage fails', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    mocks.send.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(
      createSessionArtifact({
        sessionId: session.id,
        path: 'notes/failed.md',
        content: '# Failed',
        contentType: 'text/markdown',
        artifactType: 'general',
      }),
    ).rejects.toThrow('storage unavailable');

    const [row] = await db
      .select()
      .from(taskArtifacts)
      .where(eq(taskArtifacts.sessionId, session.id));
    expect(row).toMatchObject({ taskId: null, uploaded: false });
  });

  it('rejects paths outside the artifact namespace', async () => {
    await expect(
      createSessionArtifact({
        sessionId: crypto.randomUUID(),
        path: '../secret.txt',
        content: 'secret',
        contentType: 'text/plain',
        artifactType: 'general',
      }),
    ).rejects.toThrow('path traversal');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
