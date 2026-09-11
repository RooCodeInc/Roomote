import { timingSafeEqual } from 'node:crypto';

import {
  createSessionEgressControllerToken,
  validateSessionEgressControllerToken,
} from '@roomote/auth';
import {
  authorizeSessionEgress,
  issueSessionEgressSubstitutes,
  listSessionEgressRevocations,
  registerSessionEgressWorkload,
  renewSessionEgressWorkloadLease,
  SessionEgressRegistrationError,
  terminateSessionEgressWorkload,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  SESSION_EGRESS_CONTROL_PLANE_PATH,
  sessionEgressAuthorizeSchema,
  sessionEgressRevocationsQuerySchema,
  sessionEgressWorkloadLeaseSchema,
  sessionEgressWorkloadRegisterSchema,
  sessionEgressWorkloadTerminateSchema,
  type SessionEgressAuthorization,
  type SessionEgressRevocationFeed,
  type SessionEgressWorkloadLease,
  type SessionEgressWorkloadRegister,
  type SessionEgressWorkloadRegistration,
  type SessionEgressWorkloadTerminate,
} from '@roomote/types';
import { z } from 'zod';

import { assertEgressUrlAllowed } from './safe-fetch';

/**
 * Session egress control plane service layer.
 *
 * Two service principals, deliberately different mechanisms:
 * - `controller`: a short-lived ES256 token signed with the deployment
 *   job-auth key (which controllers already hold and sandboxes never do).
 * - `gateway`: the `R_SESSION_EGRESS_GATEWAY_TOKEN` shared secret, because
 *   the gateway is an external binary that must not hold the signing key.
 *
 * Neither run tokens, user tokens, MCP tokens, nor session-broker tokens are
 * accepted anywhere on this surface.
 */
export type SessionEgressPrincipal = 'controller' | 'gateway';

export interface SessionEgressServiceOptions {
  /** Resolves the gateway shared secret; `null` disables the whole surface. */
  gatewayToken?: () => string | null;
}

export function getSessionEgressGatewayToken(): string | null {
  return Env.R_SESSION_EGRESS_GATEWAY_TOKEN?.trim() || null;
}

function constantTimeEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function bearer(header: string | undefined): string | null {
  if (
    !header ||
    header.slice(0, 6).toLowerCase() !== 'bearer' ||
    !/\s/.test(header[6] ?? '') ||
    /[\r\n]/.test(header)
  )
    return null;
  // Fixed scheme boundary plus linear scans; no overlapping whitespace matches.
  const token = header.slice(7).trim();
  return token && !/[\u2028\u2029]/.test(token) ? token : null;
}

export async function authenticateSessionEgressPrincipal(
  authorizationHeader: string | undefined,
  gatewayToken: string,
): Promise<SessionEgressPrincipal | null> {
  const token = bearer(authorizationHeader);
  if (!token) return null;
  if (constantTimeEquals(token, gatewayToken)) return 'gateway';
  try {
    await validateSessionEgressControllerToken(token);
    return 'controller';
  } catch {
    return null;
  }
}

export class SessionEgressRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code:
      | 'malformed'
      | 'workload_not_found'
      | 'run_not_eligible'
      | 'connector_identity_in_use',
  ) {
    super(code);
    this.name = 'SessionEgressRequestError';
  }
}

function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new SessionEgressRequestError(400, 'malformed');
  return parsed.data;
}

const workloadIdSchema = z.string().uuid();

export async function registerWorkload(
  input: unknown,
): Promise<SessionEgressWorkloadRegistration> {
  const parsed = parse(sessionEgressWorkloadRegisterSchema, input);
  try {
    const result = await registerSessionEgressWorkload(parsed);
    // Defense in depth: a grant whose origin no longer passes the public
    // egress policy is never handed to a workload, even as a substitute.
    return {
      ...result,
      substitutes: result.substitutes.filter((issue) =>
        isOriginAllowed(issue.origin),
      ),
    };
  } catch (error) {
    if (error instanceof SessionEgressRegistrationError)
      throw new SessionEgressRequestError(409, error.code);
    throw error;
  }
}

export async function issueSubstitutes(
  workloadId: unknown,
): Promise<SessionEgressWorkloadRegistration> {
  const id = parse(workloadIdSchema, workloadId);
  const result = await issueSessionEgressSubstitutes(id);
  if (!result) throw new SessionEgressRequestError(404, 'workload_not_found');
  return {
    ...result,
    substitutes: result.substitutes.filter((issue) =>
      isOriginAllowed(issue.origin),
    ),
  };
}

export async function renewLease(workloadId: unknown, input: unknown) {
  const id = parse(workloadIdSchema, workloadId);
  const { leaseSeconds } = parse(sessionEgressWorkloadLeaseSchema, input ?? {});
  const result = await renewSessionEgressWorkloadLease(id, leaseSeconds);
  if (!result) throw new SessionEgressRequestError(404, 'workload_not_found');
  return result;
}

export async function terminateWorkload(workloadId: unknown, input: unknown) {
  const id = parse(workloadIdSchema, workloadId);
  const { reason } = parse(sessionEgressWorkloadTerminateSchema, input ?? {});
  const terminated = await terminateSessionEgressWorkload(id, reason);
  return { workloadId: id, terminated };
}

export async function authorize(
  input: unknown,
): Promise<SessionEgressAuthorization> {
  const parsed = sessionEgressAuthorizeSchema.safeParse(input);
  // Malformed gateway input is a denial, not an exception: the gateway must
  // treat it exactly like any other refusal.
  if (!parsed.success) return { allowed: false, reason: 'malformed' };
  return authorizeSessionEgress(parsed.data, { isOriginAllowed });
}

function isOriginAllowed(origin: string): boolean {
  try {
    return assertEgressUrlAllowed(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function revocations(
  query: unknown,
): Promise<SessionEgressRevocationFeed> {
  const { after, limit } = parse(sessionEgressRevocationsQuerySchema, query);
  return listSessionEgressRevocations(after, limit);
}

/**
 * Controller-side client for the control plane. Owns URL, auth header, and
 * payload conventions so controllers never hand-assemble them. Substitute
 * plaintext returned here must go only into the workload's client
 * configuration, never into logs, snapshots, task payloads, or diagnostics.
 */
export function createSessionEgressControllerClient(options: {
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  let end = options.apiBaseUrl.length;
  while (end > 0 && options.apiBaseUrl[end - 1] === '/') end--;
  const base = `${options.apiBaseUrl.slice(0, end)}${SESSION_EGRESS_CONTROL_PLANE_PATH}`;
  async function call<T>(
    method: 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await createSessionEgressControllerToken()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: string })
      | { error?: string }
      | null;
    if (!response.ok) {
      throw new Error(
        `Session egress control plane ${method} ${path} failed: ${response.status} ${payload?.error ?? ''}`.trim(),
      );
    }
    return payload as T;
  }
  return {
    register: (input: SessionEgressWorkloadRegister) =>
      call<SessionEgressWorkloadRegistration>('POST', '/workloads', input),
    issueSubstitutes: (workloadId: string) =>
      call<SessionEgressWorkloadRegistration>(
        'POST',
        `/workloads/${encodeURIComponent(workloadId)}/substitutes`,
      ),
    renewLease: (workloadId: string, input: SessionEgressWorkloadLease) =>
      call<{ workloadId: string; generation: number; expiresAt: string }>(
        'POST',
        `/workloads/${encodeURIComponent(workloadId)}/lease`,
        input,
      ),
    terminate: (workloadId: string, input: SessionEgressWorkloadTerminate) =>
      call<{ workloadId: string; terminated: boolean }>(
        'DELETE',
        `/workloads/${encodeURIComponent(workloadId)}`,
        input,
      ),
  };
}
