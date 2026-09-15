import { Hono } from 'hono';
import { userFactory } from '@roomote/db/server';

import type { Variables } from '../../types';
import { publicRoomoteMcp } from './roomote';

function app(userId: string) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (context, next) => {
    context.set('authContext', { tokenType: 'auth', userId, version: 1 });
    await next();
  });
  app.route('/roomote', publicRoomoteMcp);
  return app;
}

function request(userId: string, method: string, params: unknown = {}) {
  return app(userId).request('/roomote', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function call(userId: string, operation: 'overview' | 'integrations') {
  return request(userId, 'tools/call', {
    name: 'get_about_me',
    arguments: { operation },
  });
}

async function toolPayload(response: Response) {
  expect(response.status).toBe(200);
  return JSON.parse((await response.json()).result.content[0].text);
}

describe('Roomote MCP get_about_me', () => {
  it('advertises the operation input used to select capability guidance', async () => {
    const user = await userFactory.create();
    const response = await request(user.id, 'tools/list');
    expect(response.status).toBe(200);

    const tools = (await response.json()).result.tools;
    const aboutMe = tools.find(
      (tool: { name: string }) => tool.name === 'get_about_me',
    );

    expect(aboutMe.inputSchema.properties.operation.enum).toEqual([
      'overview',
      'integrations',
    ]);
    expect(aboutMe.inputSchema.required).toContain('operation');
  });

  it('dispatches overview to broad answer guidance instead of legacy coding bullets', async () => {
    const user = await userFactory.create();
    const payload = await toolPayload(await call(user.id, 'overview'));

    expect(payload.requestedOperation).toBe('overview');
    expect(payload.answerGuidance).toContain(
      'I am an AI teammate people can hand real work to, not just ask for advice.',
    );
    expect(payload.answerGuidance).toContain(
      'Focus on the problems I can take off their plate and the useful result they can get back.',
    );
    expect(payload.answerGuidance).toContain(
      'distinguish work I can carry out from material I can prepare for approval',
    );
    expect(payload).not.toHaveProperty('capabilities');
    expect(payload).not.toHaveProperty('gettingStarted');
    expect(payload).not.toHaveProperty('deployment');
    expect(payload).not.toHaveProperty('integrations');
    expect(payload).not.toHaveProperty('configuredMcpServers');
  });

  it('keeps integration setup details on the integrations operation', async () => {
    const user = await userFactory.create();
    const payload = await toolPayload(await call(user.id, 'integrations'));

    expect(payload.requestedOperation).toBe('integrations');
    expect(payload).toHaveProperty('gettingStarted');
    expect(payload).not.toHaveProperty('answerGuidance');
    expect(payload).not.toHaveProperty('capabilities');
  });
});
