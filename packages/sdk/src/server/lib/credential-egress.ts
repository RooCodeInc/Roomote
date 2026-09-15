import {
  createCredentialEgressControllerToken,
  validateCredentialEgressControllerToken,
} from '@roomote/auth';
import {
  authorizeCredentialEgressProxy,
  issueCredentialEgressSubstitutes,
  registerCredentialEgressWorkload,
  renewCredentialEgressWorkloadLease,
  CredentialEgressRegistrationError,
  terminateCredentialEgressWorkload,
} from '@roomote/db/server';
import {
  CREDENTIAL_EGRESS_CONTROL_PLANE_PATH,
  credentialEgressProxyAuthorizeSchema,
  credentialEgressWorkloadLeaseSchema,
  credentialEgressWorkloadRegisterSchema,
  credentialEgressWorkloadTerminateSchema,
  type CredentialEgressAuthorization,
  type CredentialEgressWorkloadLease,
  type CredentialEgressWorkloadRegister,
  type CredentialEgressWorkloadRegistration,
  type CredentialEgressWorkloadTerminate,
} from '@roomote/types';
import { z } from 'zod';

import { assertEgressUrlAllowed } from './safe-fetch';

/**
 * Credential egress control plane service layer.
 *
 * One service principal: the controller, authenticated by a short-lived
 * ES256 token signed with the deployment job-auth key (which controllers
 * already hold and sandboxes never do). Run tokens, user tokens, MCP tokens,
 * and session-broker tokens are not accepted anywhere on this surface. The
 * API-side proxy authorizes substitutes in-process through `authorizeProxy`.
 */
export type CredentialEgressPrincipal = 'controller';

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

export async function authenticateCredentialEgressPrincipal(
  authorizationHeader: string | undefined,
): Promise<CredentialEgressPrincipal | null> {
  const token = bearer(authorizationHeader);
  if (!token) return null;
  try {
    await validateCredentialEgressControllerToken(token);
    return 'controller';
  } catch {
    return null;
  }
}

export class CredentialEgressRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code:
      | 'malformed'
      | 'workload_not_found'
      | 'run_not_eligible'
      | 'connector_identity_in_use',
  ) {
    super(code);
    this.name = 'CredentialEgressRequestError';
  }
}

function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new CredentialEgressRequestError(400, 'malformed');
  return parsed.data;
}

const workloadIdSchema = z.string().uuid();

export async function registerWorkload(
  input: unknown,
): Promise<CredentialEgressWorkloadRegistration> {
  const parsed = parse(credentialEgressWorkloadRegisterSchema, input);
  try {
    return await registerCredentialEgressWorkload(parsed, { isOriginAllowed });
  } catch (error) {
    if (error instanceof CredentialEgressRegistrationError)
      throw new CredentialEgressRequestError(409, error.code);
    throw error;
  }
}

export async function issueSubstitutes(
  workloadId: unknown,
): Promise<CredentialEgressWorkloadRegistration> {
  const id = parse(workloadIdSchema, workloadId);
  const result = await issueCredentialEgressSubstitutes(id, {
    isOriginAllowed,
  });
  if (!result)
    throw new CredentialEgressRequestError(404, 'workload_not_found');
  return result;
}

export async function renewLease(workloadId: unknown, input: unknown) {
  const id = parse(workloadIdSchema, workloadId);
  const { leaseSeconds } = parse(
    credentialEgressWorkloadLeaseSchema,
    input ?? {},
  );
  const result = await renewCredentialEgressWorkloadLease(id, leaseSeconds);
  if (!result)
    throw new CredentialEgressRequestError(404, 'workload_not_found');
  return result;
}

export async function terminateWorkload(workloadId: unknown, input: unknown) {
  const id = parse(workloadIdSchema, workloadId);
  const { reason } = parse(
    credentialEgressWorkloadTerminateSchema,
    input ?? {},
  );
  const terminated = await terminateCredentialEgressWorkload(id, reason);
  return { workloadId: id, terminated };
}

/**
 * Live per-request decision for the API-side proxy. Malformed input is a
 * denial, not an exception: the proxy treats it like any other refusal.
 */
export async function authorizeProxy(
  input: unknown,
): Promise<CredentialEgressAuthorization> {
  const parsed = credentialEgressProxyAuthorizeSchema.safeParse(input);
  if (!parsed.success) return { allowed: false, reason: 'malformed' };
  return authorizeCredentialEgressProxy(parsed.data, { isOriginAllowed });
}

function isOriginAllowed(origin: string): boolean {
  try {
    return assertEgressUrlAllowed(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Controller-side client for the control plane. Owns URL, auth header, and
 * payload conventions so controllers never hand-assemble them. Substitute
 * plaintext returned here must go only into the workload's client
 * configuration, never into logs, snapshots, task payloads, or diagnostics.
 */
export function createCredentialEgressControllerClient(options: {
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  let end = options.apiBaseUrl.length;
  while (end > 0 && options.apiBaseUrl[end - 1] === '/') end--;
  const base = `${options.apiBaseUrl.slice(0, end)}${CREDENTIAL_EGRESS_CONTROL_PLANE_PATH}`;
  async function call<T>(
    method: 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${await createCredentialEgressControllerToken()}`,
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
        `Credential egress control plane ${method} ${path} failed: ${response.status} ${payload?.error ?? ''}`.trim(),
      );
    }
    return payload as T;
  }
  return {
    register: (input: CredentialEgressWorkloadRegister) =>
      call<CredentialEgressWorkloadRegistration>('POST', '/workloads', input),
    issueSubstitutes: (workloadId: string) =>
      call<CredentialEgressWorkloadRegistration>(
        'POST',
        `/workloads/${encodeURIComponent(workloadId)}/substitutes`,
      ),
    renewLease: (workloadId: string, input: CredentialEgressWorkloadLease) =>
      call<{ workloadId: string; generation: number; expiresAt: string }>(
        'POST',
        `/workloads/${encodeURIComponent(workloadId)}/lease`,
        input,
      ),
    terminate: (workloadId: string, input: CredentialEgressWorkloadTerminate) =>
      call<{ workloadId: string; terminated: boolean }>(
        'DELETE',
        `/workloads/${encodeURIComponent(workloadId)}`,
        input,
      ),
  };
}
