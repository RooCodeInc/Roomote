import { OPEN_ARTIFACT_TOOL } from '@roomote/types';

const { invokeInProcessApi } = vi.hoisted(() => ({
  invokeInProcessApi: vi.fn(),
}));

vi.mock('../in-process-api', () => ({
  invokeInProcessApi,
  toolResultFromApi: vi.fn((result) => result),
}));

import { registerRoomoteArtifactTool } from '../roomote-artifacts-tool';

it('registers the shared open_artifact contract and routes calls in-process', async () => {
  const registerTool = vi.fn();
  const auth = {
    userId: 'user-1',
    authContext: { userId: 'user-1', tokenType: 'auth', version: 1 },
  } as const;
  registerRoomoteArtifactTool({ registerTool } as never, auth);

  expect(registerTool).toHaveBeenCalledOnce();
  const [name, config, handler] = registerTool.mock.calls[0]!;
  expect(name).toBe(OPEN_ARTIFACT_TOOL.name);
  expect(config.title).toBe(OPEN_ARTIFACT_TOOL.title);
  expect(config.description).toBe(OPEN_ARTIFACT_TOOL.description);
  expect(config.annotations).toEqual(OPEN_ARTIFACT_TOOL.annotations);
  expect(
    config.inputSchema.safeParse({
      taskId: 'task-1',
      path: 'plans/summary.md',
    }).success,
  ).toBe(true);
  expect(
    config.inputSchema.safeParse({
      artifactId: 'guessed-id',
      path: 'plans/summary.md',
    }).success,
  ).toBe(false);
  const exactPath = 'plans/summary.md ';
  expect(
    config.inputSchema.parse({ taskId: 'task-1', path: exactPath }).path,
  ).toBe(exactPath);

  invokeInProcessApi.mockResolvedValueOnce({
    ok: true,
    status: 200,
    payload: { content: 'artifact text' },
  });
  await handler({ taskId: 'task-1', path: 'plans/summary.md' });
  expect(invokeInProcessApi).toHaveBeenCalledWith(
    expect.objectContaining({
      auth,
      path: '/artifacts/open',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1', path: 'plans/summary.md' }),
      }),
    }),
  );
});
