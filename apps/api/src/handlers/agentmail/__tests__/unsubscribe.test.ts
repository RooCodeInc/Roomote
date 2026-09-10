import { randomUUID } from 'node:crypto';

import { agentmailSuppressions, db, eq } from '@roomote/db/server';
import {
  buildAgentMailEmailLinkToken,
  buildAgentMailUnsubscribeToken,
  buildAgentMailUnsubscribeUrl,
  isAgentMailAddressSuppressed,
  verifyAgentMailUnsubscribeToken,
} from '@roomote/sdk/server';

import { agentmail } from '../index.js';

function uniqueEmail(): string {
  return `${randomUUID()}@example.test`;
}

describe('agentmail unsubscribe tokens', () => {
  it('round-trips and rejects tampered or expired tokens', () => {
    const email = uniqueEmail();
    const token = buildAgentMailUnsubscribeToken(email);
    expect(verifyAgentMailUnsubscribeToken(token)).toEqual({
      emailAddress: email,
    });
    expect(verifyAgentMailUnsubscribeToken(`${token}x`)).toBeNull();
    expect(
      verifyAgentMailUnsubscribeToken(
        buildAgentMailUnsubscribeToken(email, Date.now() - 1_000),
      ),
    ).toBeNull();
  });

  it('is domain-separated from email-link tokens', () => {
    const email = uniqueEmail();
    expect(
      verifyAgentMailUnsubscribeToken(buildAgentMailEmailLinkToken(email)),
    ).toBeNull();
  });
});

describe('agentmail unsubscribe endpoint', () => {
  it('GET is read-only: renders the confirm form without suppressing', async () => {
    const email = uniqueEmail();
    const url = new URL(buildAgentMailUnsubscribeUrl(email));

    const response = await agentmail.request(`/unsubscribe${url.search}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Unsubscribe');
    expect(html).toContain('method="post"');

    expect(await isAgentMailAddressSuppressed(email)).toBe(false);
  });

  it('POST with a query token (RFC 8058 one-click) suppresses the address', async () => {
    const email = uniqueEmail();
    const url = new URL(buildAgentMailUnsubscribeUrl(email));

    const response = await agentmail.request(`/unsubscribe${url.search}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(response.status).toBe(200);

    expect(await isAgentMailAddressSuppressed(email)).toBe(true);
    const row = await db.query.agentmailSuppressions.findFirst({
      where: eq(agentmailSuppressions.emailAddress, email),
    });
    expect(row?.reason).toBe('unsubscribe');
  });

  it('POST with a form-body token suppresses the address and repeats are no-ops', async () => {
    const email = uniqueEmail();
    const token = buildAgentMailUnsubscribeToken(email);
    const body = new URLSearchParams({ token }).toString();

    const first = await agentmail.request('/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(first.status).toBe(200);
    const second = await agentmail.request('/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(second.status).toBe(200);

    expect(await isAgentMailAddressSuppressed(email)).toBe(true);
  });

  it('rejects missing or invalid tokens', async () => {
    const missing = await agentmail.request('/unsubscribe', {
      method: 'POST',
    });
    expect(missing.status).toBe(400);

    const invalid = await agentmail.request('/unsubscribe?token=nope', {
      method: 'POST',
    });
    expect(invalid.status).toBe(400);
  });
});
