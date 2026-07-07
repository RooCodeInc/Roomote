import { createHmac, timingSafeEqual } from 'node:crypto';

import { decodeRecord } from '@/lib/url-coder';

import { resolveSlackSigningSecret } from '@roomote/db/server';

const DEFAULT_SLACK_OAUTH_REDIRECT_PATH = '/settings';
const SIGNED_INSTALL_STATE_VERSION = 1;
const SIGNED_INSTALL_STATE_MAX_AGE_MS = 60 * 60 * 1000;

type SignedSlackInstallStatePayload = {
  version: typeof SIGNED_INSTALL_STATE_VERSION;
  mode: 'install';
  redirectPath: string;
  issuedAt: number;
};

type DecodedSlackOAuthState =
  | {
      mode: 'install';
      redirectPath: string;
    }
  | {
      mode: 'link_account';
      redirectPath: string;
    };

function normalizeSlackOAuthRedirectPath(redirectPath?: string | null): string {
  if (
    redirectPath &&
    redirectPath.startsWith('/') &&
    !redirectPath.startsWith('//') &&
    !redirectPath.includes('://')
  ) {
    return redirectPath;
  }

  return DEFAULT_SLACK_OAUTH_REDIRECT_PATH;
}

async function signSlackInstallStatePayload(payload: string): Promise<string> {
  const signingSecret = await resolveSlackSigningSecret();

  if (!signingSecret) {
    throw new Error(
      'Slack signing secret is not configured; cannot sign install state.',
    );
  }

  return createHmac('sha256', signingSecret)
    .update(payload)
    .digest('base64url');
}

function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export async function createSignedSlackInstallState({
  redirectPath,
}: {
  redirectPath?: string | null;
}): Promise<string> {
  const payload = Buffer.from(
    JSON.stringify({
      version: SIGNED_INSTALL_STATE_VERSION,
      mode: 'install',
      redirectPath: normalizeSlackOAuthRedirectPath(redirectPath),
      issuedAt: Date.now(),
    } satisfies SignedSlackInstallStatePayload),
  ).toString('base64url');

  return `${payload}.${await signSlackInstallStatePayload(payload)}`;
}

async function decodeSignedSlackInstallState(
  state: string,
): Promise<Extract<DecodedSlackOAuthState, { mode: 'install' }> | null> {
  const [encodedPayload, signature, ...rest] = state.split('.');

  if (!encodedPayload || !signature || rest.length > 0) {
    return null;
  }

  const expectedSignature = await signSlackInstallStatePayload(encodedPayload);
  if (!signaturesMatch(expectedSignature, signature)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<SignedSlackInstallStatePayload>;

    if (
      payload.version !== SIGNED_INSTALL_STATE_VERSION ||
      payload.mode !== 'install' ||
      typeof payload.redirectPath !== 'string' ||
      typeof payload.issuedAt !== 'number' ||
      !Number.isFinite(payload.issuedAt)
    ) {
      return null;
    }

    if (Date.now() - payload.issuedAt > SIGNED_INSTALL_STATE_MAX_AGE_MS) {
      return null;
    }

    // Re-normalize decoded payloads and reject any state that only becomes safe
    // after normalization, instead of silently accepting the fallback path.
    const redirectPath = normalizeSlackOAuthRedirectPath(payload.redirectPath);
    if (redirectPath !== payload.redirectPath) {
      return null;
    }

    return {
      mode: 'install',
      redirectPath,
    };
  } catch {
    return null;
  }
}

export async function decodeSlackOAuthState(
  state: string | null | undefined,
): Promise<DecodedSlackOAuthState | null> {
  if (!state) {
    return null;
  }

  const installState = await decodeSignedSlackInstallState(state);
  if (installState) {
    return installState;
  }

  const decoded = decodeRecord<Record<string, string>>(state);
  if (decoded?.mode === 'link_account') {
    return {
      mode: 'link_account',
      redirectPath: normalizeSlackOAuthRedirectPath(decoded.redirect),
    };
  }

  return null;
}
