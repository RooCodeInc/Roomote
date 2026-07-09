import type { CloudJob } from '@roomote/db';
import type { PreviewTokenContext } from '@roomote/types';

import type { ResolvedRequest } from '../services/resolver';

/**
 * Standard test task ID used across preview-proxy tests.
 */
export const TEST_TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * Standard test host used across preview-proxy tests.
 */
export const TEST_HOST = `${TEST_TASK_ID}-web.roomote-preview.dev`;

/**
 * Mock config values for tests.
 */
type MockConfig = {
  PORT: string;
  NODE_ENV: 'test';
  ROOMOTE_APP_URL: string;
  PREVIEW_TOKEN_TTL_SECONDS: string;
  PREVIEW_AUTH_COOKIE_NAME: string;
  PREVIEW_PROXY_SUBDOMAIN_SUFFIX: string | undefined;
};

export const mockConfig: MockConfig = {
  PORT: '0',
  NODE_ENV: 'test',
  ROOMOTE_APP_URL: 'https://api.example.com',
  PREVIEW_TOKEN_TTL_SECONDS: '3600',
  PREVIEW_AUTH_COOKIE_NAME: 'preview_auth',
  PREVIEW_PROXY_SUBDOMAIN_SUFFIX: undefined,
};

/**
 * Create a mock cloud job object for tests.
 */
export function createMockCloudJob(
  overrides: {
    id?: number;
    taskId?: string | null;
    actingUserId?: string | null;
    payload?: Record<string, unknown> | null;
  } = {},
): CloudJob {
  return {
    id: overrides.id ?? 1,
    taskId: 'taskId' in overrides ? overrides.taskId : TEST_TASK_ID,
    actingUserId: overrides.actingUserId ?? null,
    payload: overrides.payload ?? null,
  } as unknown as CloudJob;
}

/**
 * Create a mock resolved request for tests.
 * This is the new combined result type from resolveRequest.
 */
export function createMockResolvedRequest(
  overrides: Partial<ResolvedRequest> = {},
): ResolvedRequest {
  const status = overrides.status ?? 'active';
  const cloudJob =
    'cloudJob' in overrides ? overrides.cloudJob : createMockCloudJob();

  return {
    status,
    sandboxUrl:
      status === 'active'
        ? (overrides.sandboxUrl ?? 'http://sandbox.example.com:3000')
        : undefined,
    redirectUrl: status === 'redirect' ? overrides.redirectUrl : undefined,
    directUrl:
      status === 'redirect_to_direct'
        ? (overrides.directUrl ?? 'https://direct-sandbox.example.com:3000')
        : undefined,
    cloudJob: cloudJob ?? null,
    requiresAuth: overrides.requiresAuth ?? true,
    hasAuthProxy: overrides.hasAuthProxy ?? false,
    taskId:
      'taskId' in overrides
        ? overrides.taskId
        : cloudJob
          ? TEST_TASK_ID
          : undefined,
    error: overrides.error,
    // Resumable status fields
    snapshotId:
      status === 'resumable'
        ? (overrides.snapshotId ?? 'snap_test123')
        : undefined,
    snapshotCreatedAt:
      status === 'resumable'
        ? (overrides.snapshotCreatedAt ?? new Date())
        : undefined,
    wildcardPrefix: overrides.wildcardPrefix,
    authBypassPaths: overrides.authBypassPaths,
    authBypassHeaderValue: overrides.authBypassHeaderValue,
    authBypassHeaderName: overrides.authBypassHeaderName,
    requestedPortKey: overrides.requestedPortKey,
  };
}

/**
 * Create a mock auth validation result for tests.
 */
export function createMockAuthResult(
  overrides: {
    valid?: boolean;
    reason?: 'missing' | 'invalid' | 'job_not_found';
    taskId?: string;
    token?: PreviewTokenContext;
  } = {},
) {
  return {
    valid: overrides.valid ?? false,
    reason: overrides.reason ?? 'missing',
    taskId: overrides.taskId ?? TEST_TASK_ID,
    token: overrides.token,
  };
}

/**
 * Create a mock parseHost result for tests.
 */
export function createMockParseHostResult(
  overrides: {
    portName?: string;
    taskId?: string | null;
    isValid?: boolean;
  } = {},
) {
  return {
    portName: overrides.portName ?? 'web',
    taskId: overrides.taskId ?? TEST_TASK_ID,
    isValid: overrides.isValid ?? true,
  };
}
