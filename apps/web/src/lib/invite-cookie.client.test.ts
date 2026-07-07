import { afterEach, describe, expect, it } from 'vitest';

import {
  INVITE_COOKIE_NAME,
  readInviteTokenFromDocumentCookie,
} from './invite-cookie';

function clearInviteCookie() {
  document.cookie = `${INVITE_COOKIE_NAME}=; path=/; max-age=0`;
}

describe('readInviteTokenFromDocumentCookie', () => {
  afterEach(clearInviteCookie);

  it('returns null when the cookie is not set', () => {
    expect(readInviteTokenFromDocumentCookie()).toBeNull();
  });

  it('reads the invite cookie value', () => {
    document.cookie = `${INVITE_COOKIE_NAME}=setup-secret; path=/`;

    expect(readInviteTokenFromDocumentCookie()).toBe('setup-secret');
  });

  it('decodes URI-encoded values, including = characters', () => {
    document.cookie = `${INVITE_COOKIE_NAME}=${encodeURIComponent('token=with=equals')}; path=/`;

    expect(readInviteTokenFromDocumentCookie()).toBe('token=with=equals');
  });

  it('returns null for an empty cookie value', () => {
    document.cookie = `${INVITE_COOKIE_NAME}=; path=/`;

    expect(readInviteTokenFromDocumentCookie()).toBeNull();
  });
});
