import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  findSession: vi.fn(),
  lookupIds: vi.fn(),
  client: vi.fn(),
  ticket: vi.fn(),
  complete: vi.fn(),
  fetch: vi.fn(),
  convert: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  store: new Map<string, string>(),
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
  fastAgentConversationRepository: {
    findById: mocks.findSession,
    getLookupIds: mocks.lookupIds,
  },
}));
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ set: mocks.set, get: mocks.get, del: mocks.del }),
}));
vi.mock('@roomote/slack', () => ({ createSlackWebClient: mocks.client }));
vi.mock('./fast-agent-video-conversion', () => ({
  convertFastAgentWebmToMp4: mocks.convert,
  MAX_FAST_VIDEO_BYTES: 50 * 1024 * 1024,
}));

import {
  db,
  eq,
  fastAgentConversations,
  runFactory,
  sessionFactory,
  slackInstallationFactory,
  slackInstallations,
  taskArtifacts,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  deliverFastAgentSessionVideos,
  resolveFastAgentSessionVideos,
} from './fast-agent-session-videos';

const sessionId = randomUUID();
const aliasId = randomUUID();
const params = { sessionId, channelId: 'CVIDEO', threadTs: '123.456' };
const original = Buffer.from('original video');
let teamId: string;
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

function viewerLink(video: typeof taskArtifacts.$inferSelect) {
  const baseUrl = (Env.R_PUBLIC_URL ?? Env.R_APP_URL).replace(/\/+$/, '');
  return `[View video](${baseUrl}/task/${video.taskId}/artifacts/${video.path}?v=${video.version})`;
}

function storageObject(
  chunks: Uint8Array[] = [original],
  contentLength = original.length,
) {
  return {
    ContentLength: contentLength,
    Body: {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
    },
  };
}

async function artifact(
  overrides: Partial<typeof taskArtifacts.$inferInsert> = {},
  parentId = sessionId,
) {
  const run = await runFactory.create({
    payload: {
      repo: 'test/repo',
      description: 'video',
      fastAgentSessionId: parentId,
    },
  });
  const [row] = await db
    .insert(taskArtifacts)
    .values({
      taskId: run.taskId,
      runId: run.id,
      path: 'proof/demo.mp4',
      version: 1,
      contentType: 'video/mp4',
      size: original.length,
      uploaded: true,
      ...overrides,
    })
    .returning();
  return row!;
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.store.clear();
  const user = await userFactory.create();
  const installation = await slackInstallationFactory.create({
    installedByUserId: user.id,
  });
  teamId = installation.teamId;
  mocks.findSession.mockResolvedValue({
    id: sessionId,
    conversation: {
      surface: 'slack',
      workspaceId: teamId,
      replyTarget: { channelId: params.channelId, threadId: params.threadTs },
    },
  });
  mocks.lookupIds.mockResolvedValue([sessionId, aliasId]);
  mocks.send.mockImplementation(async () => storageObject());
  mocks.client.mockReturnValue({
    files: {
      getUploadURLExternal: mocks.ticket,
      completeUploadExternal: mocks.complete,
    },
  });
  mocks.ticket.mockResolvedValue({
    ok: true,
    file_id: 'FVIDEO',
    upload_url: 'https://files.slack.com/upload/ticket',
  });
  mocks.complete.mockResolvedValue({ ok: true, files: [{ id: 'FVIDEO' }] });
  mocks.fetch.mockImplementation(
    async () => new Response('OK', { status: 200 }),
  );
  mocks.convert.mockResolvedValue(Buffer.from('converted mp4'));
  mocks.set.mockImplementation(
    async (
      key: string,
      value: string,
      _ex: string,
      _ttl: number,
      nx?: string,
    ) => {
      if (nx === 'NX' && mocks.store.has(key)) return null;
      mocks.store.set(key, value);
      return 'OK';
    },
  );
  mocks.get.mockImplementation(
    async (key: string) => mocks.store.get(key) ?? null,
  );
  mocks.del.mockImplementation(async (key: string) =>
    Number(mocks.store.delete(key)),
  );
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

it('does nothing for an empty batch', async () => {
  expect(
    await deliverFastAgentSessionVideos({ ...params, artifactIds: [] }),
  ).toBe('');
  expect(mocks.findSession).not.toHaveBeenCalled();
  expect(mocks.client).not.toHaveBeenCalled();
});

it.each([
  'missing',
  'foreign',
  'unuploaded',
  'nonvideo',
  'runless',
  'wrong-task',
])('rejects the entire batch before side effects: %s', async (kind) => {
  const valid = await artifact();
  let badId: string = randomUUID();
  if (kind !== 'missing') {
    const overrides: Partial<typeof taskArtifacts.$inferInsert> = {};
    if (kind === 'unuploaded') overrides.uploaded = false;
    if (kind === 'nonvideo') overrides.contentType = 'image/png';
    if (kind === 'runless') overrides.runId = null;
    if (kind === 'wrong-task')
      overrides.taskId = (await taskFactory.create()).id;
    badId = (
      await artifact(overrides, kind === 'foreign' ? randomUUID() : sessionId)
    ).id;
  }
  await expect(
    deliverFastAgentSessionVideos({
      ...params,
      artifactIds: [valid.id, badId],
    }),
  ).rejects.toThrow('Invalid Fast parent video artifact');
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.convert).not.toHaveBeenCalled();
  expect(mocks.client).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it('resolves legacy Session lookup IDs and deduplicates selection', async () => {
  const video = await artifact({}, aliasId);
  const result = await resolveFastAgentSessionVideos({
    ...params,
    artifactIds: [video.id, video.id],
  });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    id: video.id,
    taskId: video.taskId,
    filename: 'demo.mp4',
  });
  expect(result[0]?.viewUrl).toContain(
    `/task/${video.taskId}/artifacts/proof/demo.mp4?v=1`,
  );
});

it('resolves and streams Session-owned recordings from the Fast browse tool', async () => {
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId: (await userFactory.create()).id,
      surface: 'slack',
      workspaceId: teamId,
      conversationId: randomUUID(),
      currentReplyChannelId: params.channelId,
      currentReplyThreadId: params.threadTs,
    })
    .returning();
  const ownerSession = await sessionFactory.create({
    fastConversationId: conversation!.id,
  });
  mocks.lookupIds.mockResolvedValue([sessionId, aliasId, conversation!.id]);
  const [video] = await db
    .insert(taskArtifacts)
    .values({
      sessionId: ownerSession.id,
      path: 'browser/recording-1.webm',
      version: 1,
      artifactType: 'visual-proof',
      contentType: 'video/webm',
      size: original.length,
      uploaded: true,
    })
    .returning();
  const resolved = await resolveFastAgentSessionVideos({
    ...params,
    artifactIds: [video!.id],
  });
  expect(resolved[0]).toMatchObject({
    id: video!.id,
    owner: { sessionId: ownerSession.id },
    filename: 'recording-1.webm',
  });
  expect(resolved[0]?.viewUrl).toContain(
    `/sessions/${ownerSession.id}?artifact=browser%2Frecording-1.webm&v=1`,
  );
  expect(
    await deliverFastAgentSessionVideos({
      ...params,
      artifactIds: [video!.id],
    }),
  ).toBe('');
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        Key: `sessions/${ownerSession.id}/artifacts/${video!.id}/v1/browser/recording-1.webm`,
      }),
    }),
    { abortSignal: expect.any(AbortSignal) },
  );
});

it('rejects a Session-owned artifact from another Session', async () => {
  const foreignSession = await sessionFactory.create();
  const [video] = await db
    .insert(taskArtifacts)
    .values({
      sessionId: foreignSession.id,
      path: 'browser/recording-1.webm',
      version: 1,
      artifactType: 'visual-proof',
      contentType: 'video/webm',
      size: original.length,
      uploaded: true,
    })
    .returning();
  await expect(
    deliverFastAgentSessionVideos({ ...params, artifactIds: [video!.id] }),
  ).rejects.toThrow('Invalid Fast parent video artifact');
});

it('retrieves owned bytes and uses the documented Slack external upload sequence in the exact thread', async () => {
  const video = await artifact();
  expect(
    await deliverFastAgentSessionVideos({
      ...params,
      artifactIds: [video.id, video.id],
    }),
  ).toBe('');
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        Key: `tasks/${video.taskId}/artifacts/${video.id}/v1/proof/demo.mp4`,
      }),
    }),
    { abortSignal: expect.any(AbortSignal) },
  );
  expect(mocks.client).toHaveBeenCalledWith(expect.stringContaining('xoxb-'), {
    timeout: 30_000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  });
  expect(mocks.ticket).toHaveBeenCalledExactlyOnceWith({
    filename: 'demo.mp4',
    length: original.length,
  });
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
    'https://files.slack.com/upload/ticket',
    expect.objectContaining({
      method: 'POST',
      body: new Uint8Array(original),
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }),
  );
  expect(mocks.complete).toHaveBeenCalledExactlyOnceWith({
    files: [{ id: 'FVIDEO', title: 'demo.mp4' }],
    channel_id: 'CVIDEO',
    thread_ts: '123.456',
  });
  expect(mocks.convert).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(mocks.ticket.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.fetch.mock.invocationCallOrder[0]!,
  );
  expect(mocks.fetch.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.complete.mock.invocationCallOrder[0]!,
  );
});

it('converts only a WebM delivery copy and leaves the stored artifact unchanged', async () => {
  const video = await artifact({
    path: 'proof/demo.webm',
    contentType: 'video/webm',
  });
  expect(
    await deliverFastAgentSessionVideos({ ...params, artifactIds: [video.id] }),
  ).toBe('');
  expect(mocks.convert).toHaveBeenCalledExactlyOnceWith(original);
  expect(mocks.ticket).toHaveBeenCalledWith({
    filename: 'demo.mp4',
    length: Buffer.byteLength('converted mp4'),
  });
  expect(mocks.fetch.mock.calls[0]?.[1].body).toEqual(
    new Uint8Array(Buffer.from('converted mp4')),
  );
  const stored = await db.query.taskArtifacts.findFirst({
    where: eq(taskArtifacts.id, video.id),
  });
  expect(stored).toEqual(video);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it.each([
  'conversion',
  'size-limit',
  'storage',
  'ticket',
  'missing-scope',
  'upload',
  'completion',
])(
  'returns only an authorized viewer link and logs sanitized context on %s failure',
  async (stage) => {
    const video = await artifact({
      path: 'proof/demo.webm',
      contentType: 'video/webm',
    });
    if (stage === 'conversion')
      mocks.convert.mockRejectedValueOnce(new Error('ffmpeg missing'));
    if (stage === 'size-limit')
      mocks.convert.mockRejectedValueOnce(
        Object.assign(new Error('File size limit exceeded'), {
          signal: 'SIGXFSZ',
        }),
      );
    if (stage === 'storage')
      mocks.send.mockRejectedValueOnce(new Error('S3 unavailable'));
    if (stage === 'ticket') mocks.ticket.mockResolvedValueOnce({ ok: false });
    if (stage === 'missing-scope')
      mocks.ticket.mockRejectedValueOnce(
        Object.assign(
          new Error('missing_scope xoxb-secret https://secret/upload'),
          {
            data: { error: 'missing_scope', needed: 'files:write' },
          },
        ),
      );
    if (stage === 'upload')
      mocks.fetch.mockResolvedValueOnce(
        new Response('failed', { status: 500 }),
      );
    if (stage === 'completion')
      mocks.complete.mockRejectedValueOnce(new Error('timeout'));
    const text = await deliverFastAgentSessionVideos({
      ...params,
      artifactIds: [video.id],
    });
    expect(text).toBe(viewerLink(video));
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[Fast Agent] Native Slack video delivery failed.',
      {
        sessionId,
        artifactId: video.id,
        stage:
          stage === 'size-limit'
            ? 'conversion'
            : stage === 'ticket' || stage === 'missing-scope'
              ? 'upload-ticket'
              : stage,
        completing: stage === 'completion',
      },
    );
    if (stage !== 'completion') expect(mocks.complete).not.toHaveBeenCalled();
  },
);

it('persists successful dedup for seven days across retries and Session aliases', async () => {
  const video = await artifact();
  const input = { ...params, artifactIds: [video.id] };
  expect(await deliverFastAgentSessionVideos(input)).toBe('');
  expect(
    await deliverFastAgentSessionVideos({ ...input, sessionId: aliasId }),
  ).toBe('');
  expect(mocks.ticket).toHaveBeenCalledTimes(1);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.set).toHaveBeenCalledWith(
    `fast-slack-video:${JSON.stringify([sessionId, 'CVIDEO', '123.456', video.id])}`,
    'delivered',
    'EX',
    604800,
  );
});

it('retains ambiguous completion claims, never repeating the upload on retry', async () => {
  const video = await artifact();
  const input = { ...params, artifactIds: [video.id] };
  mocks.complete.mockRejectedValueOnce(
    new Error('response lost after Slack accepted'),
  );
  expect(await deliverFastAgentSessionVideos(input)).toBe(viewerLink(video));
  expect(await deliverFastAgentSessionVideos(input)).toBe(viewerLink(video));
  expect(mocks.ticket).toHaveBeenCalledTimes(1);
  expect(mocks.complete).toHaveBeenCalledTimes(1);
  expect(mocks.del).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
});

it('retries a definite pre-completion failure', async () => {
  const video = await artifact();
  const input = { ...params, artifactIds: [video.id] };
  mocks.fetch.mockRejectedValueOnce(new Error('upload failed'));
  expect(await deliverFastAgentSessionVideos(input)).toContain('[View video]');
  expect(await deliverFastAgentSessionVideos(input)).toBe('');
  expect(mocks.complete).toHaveBeenCalledTimes(1);
});

it('fails closed when KV is unavailable', async () => {
  const video = await artifact();
  mocks.set.mockRejectedValueOnce(new Error('Redis unavailable'));
  expect(
    await deliverFastAgentSessionVideos({ ...params, artifactIds: [video.id] }),
  ).toContain('[View video]');
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.ticket).not.toHaveBeenCalled();
});

it('does not duplicate a completed upload when saving the delivered marker fails', async () => {
  const video = await artifact();
  mocks.set.mockImplementationOnce(async (key: string, value: string) => {
    mocks.store.set(key, value);
    return 'OK';
  });
  mocks.set.mockRejectedValueOnce(
    new Error('Redis unavailable after completion'),
  );
  const input = { ...params, artifactIds: [video.id] };
  expect(await deliverFastAgentSessionVideos(input)).toContain('[View video]');
  expect(await deliverFastAgentSessionVideos(input)).toContain('[View video]');
  expect(mocks.ticket).toHaveBeenCalledTimes(1);
});

it('rejects other channel/thread destinations before side effects', async () => {
  const video = await artifact();
  await expect(
    deliverFastAgentSessionVideos({
      ...params,
      threadTs: 'other',
      artifactIds: [video.id],
    }),
  ).rejects.toThrow('Invalid Fast video Slack destination');
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it('returns a viewer fallback when Slack credentials are unavailable', async () => {
  const video = await artifact();
  await db
    .update(slackInstallations)
    .set({ isActive: false })
    .where(eq(slackInstallations.teamId, teamId));
  expect(
    await deliverFastAgentSessionVideos({ ...params, artifactIds: [video.id] }),
  ).toBe(viewerLink(video));
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    '[Fast Agent] Native Slack video delivery unavailable.',
    { sessionId, stage: 'credentials' },
  );
});

it.each(['metadata', 'content-length', 'stream', 'empty'])(
  'bounds video input bytes: %s',
  async (source) => {
    const limit = 50 * 1024 * 1024;
    const video = await artifact({
      size: source === 'metadata' ? limit + 1 : original.length,
    });
    if (source === 'content-length')
      mocks.send.mockResolvedValueOnce(storageObject([], limit + 1));
    if (source === 'stream')
      mocks.send.mockResolvedValueOnce(
        storageObject([new Uint8Array(limit), new Uint8Array(1)], 1),
      );
    if (source === 'empty')
      mocks.send.mockResolvedValueOnce(storageObject([], 0));
    expect(
      await deliverFastAgentSessionVideos({
        ...params,
        artifactIds: [video.id],
      }),
    ).toContain('[View video]');
    expect(mocks.ticket).not.toHaveBeenCalled();
  },
);

it('cancels a stalled storage stream at the read deadline', async () => {
  const video = await artifact();
  const cancel = vi.fn();
  mocks.send.mockResolvedValueOnce({
    Body: { transformToWebStream: () => new ReadableStream({ cancel }) },
  });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const spy = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation(() => timeout(10));
  try {
    expect(
      await deliverFastAgentSessionVideos({
        ...params,
        artifactIds: [video.id],
      }),
    ).toContain('[View video]');
    expect(cancel).toHaveBeenCalled();
    expect(mocks.ticket).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it('keeps per-artifact retry state after partial delivery', async () => {
  const first = await artifact();
  const second = await artifact();
  mocks.complete
    .mockResolvedValueOnce({ ok: true })
    .mockRejectedValueOnce(new Error('timeout'));
  const input = { ...params, artifactIds: [first.id, second.id] };
  const fallback = await deliverFastAgentSessionVideos(input);
  expect(fallback).toBe(viewerLink(second));
  expect(await deliverFastAgentSessionVideos(input)).toBe(fallback);
  expect(mocks.ticket).toHaveBeenCalledTimes(2);
});

it('returns only viewer links for multiple failed uploads in selection order', async () => {
  const first = await artifact();
  const second = await artifact();
  mocks.ticket.mockRejectedValue(new Error('missing_scope'));
  expect(
    await deliverFastAgentSessionVideos({
      ...params,
      artifactIds: [first.id, second.id],
    }),
  ).toBe(`${viewerLink(first)}\n\n${viewerLink(second)}`);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(mocks.complete).not.toHaveBeenCalled();
});

it('scopes dedup to channel and thread', async () => {
  const video = await artifact();
  const input = { ...params, artifactIds: [video.id] };
  expect(await deliverFastAgentSessionVideos(input)).toBe('');
  for (const target of [
    { channelId: 'COTHER', threadTs: params.threadTs },
    { channelId: 'COTHER', threadTs: '789.123' },
  ]) {
    mocks.findSession.mockResolvedValueOnce({
      id: sessionId,
      conversation: {
        surface: 'slack',
        workspaceId: teamId,
        replyTarget: { channelId: target.channelId, threadId: target.threadTs },
      },
    });
    expect(await deliverFastAgentSessionVideos({ ...input, ...target })).toBe(
      '',
    );
  }
  expect(mocks.ticket).toHaveBeenCalledTimes(3);
});

it('does not upload twice during concurrent delivery', async () => {
  const video = await artifact();
  const input = { ...params, artifactIds: [video.id] };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.ticket.mockImplementationOnce(async () => {
    await gate;
    return {
      ok: true,
      file_id: 'FVIDEO',
      upload_url: 'https://files.slack.com/upload/ticket',
    };
  });
  const first = deliverFastAgentSessionVideos(input);
  await vi.waitFor(() => expect(mocks.ticket).toHaveBeenCalledTimes(1));
  try {
    expect(await deliverFastAgentSessionVideos(input)).toContain(
      '[View video]',
    );
  } finally {
    release();
  }
  expect(await first).toBe('');
  expect(mocks.ticket).toHaveBeenCalledTimes(1);
});
