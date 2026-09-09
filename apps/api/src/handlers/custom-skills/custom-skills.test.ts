import { Hono } from 'hono';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CREATE_CUSTOM_SKILL_TOOL,
  type CreateCustomSkillInput,
} from '@roomote/types';
import { customSkillsRouter } from './index';
import { registerRoomoteCustomSkillsTool } from '../mcp/roomote-custom-skills-tool';
import type { McpAuth } from '../mcp/middleware';

const { create, resolve } = vi.hoisted(() => ({
  create: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('@roomote/db/server', () => ({
  createCustomSkill: create,
  CreateCustomSkillError: class extends Error {},
}));
vi.mock('../mcp/proxy-utils', () => ({
  resolveActingUserIdOrNull: resolve,
  toMcpToolResult: (payload: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }),
}));
const auth: McpAuth = {
  userId: 'actor',
  authContext: { userId: 'actor', tokenType: 'auth', version: 1 },
};
const input = {
  name: 'my-skill',
  description: 'Description',
  content: 'Instructions\n',
};
beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockResolvedValue('resolved-member');
  create.mockResolvedValue({
    persisted: true,
    success: true,
    name: input.name,
    scope: 'instance',
  });
});
function app() {
  const app = new Hono<{ Variables: { mcpAuth: McpAuth } }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', auth);
    await next();
  });
  app.route('/custom-skills', customSkillsRouter);
  return app;
}
it('uses resolved acting identity and returns persisted result', async () => {
  const response = await app().request('/custom-skills', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(201);
  expect(create).toHaveBeenCalledWith({
    ...input,
    actorUserId: 'resolved-member',
  });
  expect(await response.json()).toMatchObject({
    persisted: true,
    scope: 'instance',
  });
});
it('fails closed for missing or failed identity resolution', async () => {
  for (const failure of [false, true]) {
    if (failure) resolve.mockRejectedValueOnce(new Error('unavailable'));
    else resolve.mockResolvedValueOnce(null);
    const response = await app().request('/custom-skills', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Active member access required',
    });
  }
  expect(create).not.toHaveBeenCalled();
});
it('rejects malformed bodies, missing fields, and caller-supplied scope or identity', async () => {
  for (const body of [
    '{',
    JSON.stringify({ ...input, name: undefined }),
    JSON.stringify({ ...input, description: undefined }),
    JSON.stringify({ ...input, content: undefined }),
    JSON.stringify({ ...input, environmentIds: ['__all_repositories__'] }),
    JSON.stringify({ ...input, environmentId: 'environment' }),
    JSON.stringify({ ...input, workspaceId: 'workspace' }),
    JSON.stringify({ ...input, createdByUserId: 'creator' }),
    JSON.stringify({ ...input, actorUserId: 'actor' }),
    JSON.stringify({ ...input, scope: 'instance' }),
  ]) {
    expect(
      (await app().request('/custom-skills', { method: 'POST', body })).status,
    ).toBe(400);
  }
  expect(create).not.toHaveBeenCalled();
});
it('registers the shared MCP contract and calls the same in-process route', async () => {
  let handler!: (params: CreateCustomSkillInput) => Promise<unknown>;
  const registerTool = vi.fn((_name, _config, callback) => {
    handler = callback;
  });
  registerRoomoteCustomSkillsTool(
    { registerTool } as unknown as McpServer,
    auth,
  );
  expect(registerTool.mock.calls[0]?.[0]).toBe(CREATE_CUSTOM_SKILL_TOOL.name);
  expect(registerTool.mock.calls[0]?.[1].inputSchema.shape).toEqual(
    CREATE_CUSTOM_SKILL_TOOL.inputSchema,
  );
  expect(
    registerTool.mock.calls[0]?.[1].inputSchema.safeParse({
      ...input,
      environmentIds: [],
    }).success,
  ).toBe(false);
  expect(await handler(input)).toMatchObject({
    content: [expect.objectContaining({ type: 'text' })],
  });
  expect(create).toHaveBeenCalledWith({
    ...input,
    actorUserId: 'resolved-member',
  });
});
