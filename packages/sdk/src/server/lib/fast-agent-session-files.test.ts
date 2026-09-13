import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  lookupIds: vi.fn(),
  convert: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mocks.send;
  },
  GetObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
}));
vi.mock('@roomote/cloud-agents/server', () => ({
  fastAgentConversationRepository: { getLookupIds: mocks.lookupIds },
}));
vi.mock('./fast-agent-video-conversion', () => ({
  convertFastAgentWebmToMp4: mocks.convert,
  MAX_FAST_VIDEO_BYTES: 50 * 1024 * 1024,
}));

import { db, runFactory, taskArtifacts } from '@roomote/db/server';

import { prepareFastAgentSessionFiles } from './fast-agent-session-files';

const sessionId = randomUUID();

async function createArtifact(input: {
  contentType: string;
  path: string;
  size?: number;
  parentId?: string;
}) {
  const run = await runFactory.create({
    payload: {
      repo: 'test/repo',
      description: 'artifact delivery',
      fastAgentSessionId: input.parentId ?? sessionId,
    },
  });
  const [artifact] = await db
    .insert(taskArtifacts)
    .values({
      taskId: run.taskId,
      runId: run.id,
      path: input.path,
      version: 1,
      contentType: input.contentType,
      size: input.size ?? 3,
      uploaded: true,
    })
    .returning();
  return artifact!;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookupIds.mockResolvedValue([sessionId]);
  mocks.send.mockResolvedValue({
    ContentLength: 3,
    Body: {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2, 3]));
            controller.close();
          },
        }),
    },
  });
  mocks.convert.mockResolvedValue(Buffer.from([4, 5, 6]));
});

it.each([
  {
    kind: 'video' as const,
    contentType: 'video/mp4',
    path: 'proof/demo.mp4',
    expectedKind: 'video',
  },
  {
    kind: 'document' as const,
    contentType: 'application/pdf',
    path: 'reports/result.pdf',
    expectedKind: 'document',
  },
])(
  'materializes an authorized $kind artifact without exposing a raw URL',
  async (input) => {
    const artifact = await createArtifact(input);

    const result = await prepareFastAgentSessionFiles({
      artifactIds: [artifact.id],
      sessionId,
      kind: input.kind,
    });

    expect(result.files).toEqual([
      expect.objectContaining({
        filename: input.path.split('/').at(-1),
        contentType: input.contentType,
        kind: input.expectedKind,
        fallbackText: expect.stringContaining('/artifacts/'),
      }),
    ]);
    expect(result.files[0]!.fallbackText).not.toContain('/api/artifacts/');
    expect(result.fallbackText).toBe('');
  },
);

it('rejects a foreign-session artifact before reading storage', async () => {
  const artifact = await createArtifact({
    contentType: 'application/pdf',
    path: 'report.pdf',
    parentId: randomUUID(),
  });

  await expect(
    prepareFastAgentSessionFiles({
      artifactIds: [artifact.id],
      sessionId,
      kind: 'document',
    }),
  ).rejects.toThrow(`Invalid Fast parent document artifact: ${artifact.id}`);
  expect(mocks.send).not.toHaveBeenCalled();
});

it('uses the authorized viewer link instead of reading an oversized file', async () => {
  const artifact = await createArtifact({
    contentType: 'application/pdf',
    path: 'large.pdf',
    size: 50 * 1024 * 1024 + 1,
  });

  const result = await prepareFastAgentSessionFiles({
    artifactIds: [artifact.id],
    sessionId,
    kind: 'document',
  });

  expect(result.files).toEqual([]);
  expect(result.fallbackText).toContain('/artifacts/large.pdf?v=1');
  expect(mocks.send).not.toHaveBeenCalled();
});
