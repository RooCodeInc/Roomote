import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MockAgentMailServer } from '../mock-agentmail-server';
import { parseMockAgentMailConfig } from '../mock-agentmail-config';

describe('mock AgentMail harness config', () => {
  it('keeps pods, pod scoping, and delivery-failure replays through the schema', async () => {
    const config = parseMockAgentMailConfig({
      state: {
        pods: [{ pod_id: 'pod_acme', client_id: 'tenant-acme' }],
        inboxes: [
          { inbox_id: 'roomote@agentmail.to' },
          { inbox_id: 'roomote-acme@agentmail.to', pod_id: 'pod_acme' },
        ],
        webhooks: [
          {
            webhook_id: 'wh_1',
            url: 'http://localhost:4000/api/webhooks/agentmail',
            pod_ids: ['pod_acme'],
          },
        ],
      },
      replay: [
        {
          kind: 'bounce',
          inboxId: 'roomote@agentmail.to',
          recipients: ['gone@example.com'],
          bounceType: 'Permanent',
        },
        {
          kind: 'complaint',
          inboxId: 'roomote@agentmail.to',
          recipients: ['x@example.com'],
        },
        {
          inboxId: 'roomote-acme@agentmail.to',
          from: 'grace@example.com',
          text: 'hi',
        },
      ],
    });

    expect(config.state.pods).toEqual([
      { pod_id: 'pod_acme', client_id: 'tenant-acme' },
    ]);
    expect(config.state.inboxes[1]?.pod_id).toBe('pod_acme');
    expect(config.state.webhooks?.[0]?.pod_ids).toEqual(['pod_acme']);
    expect(
      config.replay?.map((event) =>
        'kind' in event && event.kind ? event.kind : 'message',
      ),
    ).toEqual(['bounce', 'complaint', 'message']);

    // The seeded pod is addressable through the pod-scoped routes.
    const server = new MockAgentMailServer({ state: config.state });
    const baseUrl = await server.start();
    try {
      const response = await fetch(`${baseUrl}/v0/pods/pod_acme/inboxes`, {
        headers: { authorization: 'Bearer any' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        inboxes: Array<{ inbox_id: string }>;
      };
      expect(body.inboxes.map((inbox) => inbox.inbox_id)).toEqual([
        'roomote-acme@agentmail.to',
      ]);
    } finally {
      await server.stop();
    }
  });

  it('accepts the checked-in example scenario', async () => {
    const raw = await readFile(
      join(__dirname, '..', '..', 'scripts', 'mock-agentmail.example.json'),
      'utf8',
    );
    const config = parseMockAgentMailConfig(JSON.parse(raw));
    expect(config.state.pods?.map((pod) => pod.pod_id)).toEqual(['pod_acme']);
  });
});
