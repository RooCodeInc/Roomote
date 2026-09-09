import { NextRequest } from 'next/server';
import {
  automations,
  customAutomations,
  db,
  eq,
  taskArtifacts,
  taskFactory,
  userFactory,
} from '@roomote/db/server';

const { authorizeRunToken } = vi.hoisted(() => ({
  authorizeRunToken: vi.fn(),
}));
vi.mock('@/lib/server', async () => ({
  ...(await import('@/lib/server/artifacts')),
  authorizeRunToken,
  generateDownloadUrl: vi.fn(async () => 'https://storage.example/artifact'),
  generateOwnedDownloadUrl: vi.fn(
    async () => 'https://storage.example/artifact',
  ),
}));

import { GET as getMetadata } from './[id]/route';
import { GET as getUrl } from './[id]/url/route';
import { POST as uploadComplete } from './[id]/upload_complete/route';
import { GET as getPath } from '../tasks/[taskId]/artifacts/[...path]/route';

it('allows authenticated artifact reads across automation owners without granting upload completion', async () => {
  const owner = await userFactory.create();
  const reader = await userFactory.create();
  await db
    .insert(automations)
    .values({ key: 'custom_automation' })
    .onConflictDoNothing();
  const [automation] = await db
    .insert(customAutomations)
    .values({
      name: `Artifact ${owner.id}`,
      prompt: 'Report',
      createdByUserId: owner.id,
    })
    .returning();
  const task = await taskFactory.create({
    initiatorKind: 'automation',
    initiatorAutomation: 'custom_automation',
    actorExternalId: automation!.id,
  });
  const [artifact] = await db
    .insert(taskArtifacts)
    .values({
      taskId: task.id,
      path: 'reports/result.txt',
      contentType: 'text/plain',
      size: 10,
      version: 1,
      uploaded: true,
    })
    .returning();
  const request = new NextRequest(
    `http://localhost/api/artifacts/${artifact!.id}?taskId=${task.id}`,
  );
  const params = { params: Promise.resolve({ id: artifact!.id }) };
  const pathParams = {
    params: Promise.resolve({
      taskId: task.id,
      path: ['reports', 'result.txt'],
    }),
  };
  authorizeRunToken.mockResolvedValue({
    success: true,
    userId: reader.id,
    isAdmin: false,
  });
  expect((await getMetadata(request, params)).status).toBe(200);
  expect((await getUrl(request, params)).status).toBe(200);
  expect((await getPath(request, pathParams)).status).toBe(200);

  await db
    .update(taskArtifacts)
    .set({ uploaded: false })
    .where(eq(taskArtifacts.id, artifact!.id));
  expect((await uploadComplete(request, params)).status).toBe(404);
  expect(
    await db.query.taskArtifacts.findFirst({
      where: eq(taskArtifacts.id, artifact!.id),
    }),
  ).toMatchObject({ uploaded: false });

  authorizeRunToken.mockResolvedValue({ success: false });
  for (const route of [getMetadata, getUrl, uploadComplete]) {
    expect((await route(request, params)).status).toBe(401);
  }
  expect((await getPath(request, pathParams)).status).toBe(401);

  authorizeRunToken.mockResolvedValue({
    success: true,
    userId: owner.id,
    isAdmin: false,
  });
  expect((await uploadComplete(request, params)).status).toBe(200);
  expect(
    await db.query.taskArtifacts.findFirst({
      where: eq(taskArtifacts.id, artifact!.id),
    }),
  ).toMatchObject({ uploaded: true });
});
