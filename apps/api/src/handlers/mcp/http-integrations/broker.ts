import { readFileSync } from 'node:fs';
import { fetch, Agent } from 'undici';
import {
  assertEgressUrlAllowed,
  createGuardedConnectOptions,
} from '@roomote/sdk/server/safe-fetch';
import { z } from 'zod';

const methods = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const maxBody = 1024 * 1024;
const maxResponse = 2 * 1024 * 1024;

// Reject ambiguous routing rather than relying on differing proxy/upstream decoders.
function validPath(value: string, query: boolean): boolean {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\#\s\u0000-\u001f\u007f]/.test(value)
  )
    return false;
  if (!query && value.includes('?')) return false;
  const pathname = value.split('?')[0]!;
  if (
    pathname.includes('//') ||
    /%(?:25|2e|2f|5c|3f|23|0[0-9a-f]|1[0-9a-f]|7f)/i.test(pathname)
  )
    return false;
  if (pathname.split('/').some((part) => part === '.' || part === '..'))
    return false;
  try {
    decodeURIComponent(value);
  } catch {
    return false;
  }
  return true;
}

const manifestSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        description: z.string().min(1).max(1024),
        origin: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return (
              url.protocol === 'https:' &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              url.pathname === '/' &&
              /^https:\/\/[^/?#\\]+\/?$/.test(value)
            );
          }),
        rules: z
          .array(
            z
              .object({
                method: methods,
                pathPrefix: z
                  .string()
                  .max(4096)
                  .refine(
                    (value) =>
                      validPath(value, false) &&
                      (value === '/' || !value.endsWith('/')),
                  ),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        credential: z
          .object({
            header: z
              .string()
              .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/)
              .refine(
                (value) =>
                  !/^(host|cookie|set-cookie|proxy-.*|connection|content-.*|transfer-encoding|te|trailer|upgrade|accept-encoding)$/i.test(
                    value,
                  ),
              ),
            valueEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
            prefix: z
              .string()
              .max(4096)
              .regex(/^[\x20-\x7e]*$/)
              .optional(),
          })
          .strict(),
        allowedUserIds: z.array(z.string().min(1)).min(1).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
  );

export const integrationRequestSchema = z
  .object({
    integrationId: z.string().max(64),
    method: methods,
    path: z
      .string()
      .max(8192)
      .refine((value) => validPath(value, true)),
    body: z
      .string()
      .max(maxBody)
      .refine((value) => Buffer.byteLength(value) <= maxBody)
      .optional(),
    contentType: z
      .enum([
        'application/json',
        'text/plain',
        'application/x-www-form-urlencoded',
      ])
      .optional(),
  })
  .strict();

export function loadHttpIntegrationsConfig(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!env.R_HTTP_INTEGRATIONS_CONFIG_PATH)
    throw new Error(
      'HTTP integrations requires R_HTTP_INTEGRATIONS_CONFIG_PATH',
    );
  try {
    const integrations = manifestSchema.parse(
      JSON.parse(readFileSync(env.R_HTTP_INTEGRATIONS_CONFIG_PATH, 'utf8')),
    );
    return { integrations };
  } catch {
    throw new Error(
      'Invalid HTTP integrations configuration: check integration manifest',
    );
  }
}

export type HttpIntegrationsConfig = ReturnType<
  typeof loadHttpIntegrationsConfig
>;
let active = 0;
const scopes = new Map<string, number>();

export async function integrationRequest(
  config: HttpIntegrationsConfig,
  scope: string,
  input: unknown,
  userId: string,
  signal?: AbortSignal,
) {
  const parsed = integrationRequestSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid integration request');
  const args = parsed.data;
  const integration = config.integrations.find(
    (item) =>
      item.id === args.integrationId &&
      (!item.allowedUserIds || item.allowedUserIds.includes(userId)),
  );
  if (!integration) throw new Error('Unknown integration');
  const url = new URL(args.path, integration.origin);
  if (
    url.origin !== new URL(integration.origin).origin ||
    !integration.rules.some(
      (rule) =>
        rule.method === args.method &&
        (rule.pathPrefix === '/' ||
          url.pathname === rule.pathPrefix ||
          url.pathname.startsWith(`${rule.pathPrefix}/`)),
    )
  )
    throw new Error('Integration destination or method is not allowed');
  if (args.body !== undefined && ['GET', 'HEAD'].includes(args.method))
    throw new Error('This method does not accept a body');
  if (active >= 32 || (scopes.get(scope) ?? 0) >= 4)
    throw new Error('Integration request concurrency limit reached');
  active++;
  scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
  let agent: Agent | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Awaited<ReturnType<typeof fetch>> | undefined;
  let complete = false;
  try {
    assertEgressUrlAllowed(url);
    // Resolve on each request so rotation never requires reloading the manifest.
    const secret = process.env[integration.credential.valueEnv];
    const credential = `${integration.credential.prefix ?? ''}${secret ?? ''}`;
    if (
      !secret ||
      secret.length > 4096 ||
      !/^[\x20-\x7e]+$/.test(secret) ||
      credential.length > 4096
    )
      throw new Error();
    agent = new Agent({
      connect: createGuardedConnectOptions({ allowedPrivateCidrs: undefined }),
    });
    const timeout = AbortSignal.timeout(30_000);
    response = await fetch(url, {
      dispatcher: agent,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'manual',
      method: args.method,
      headers: {
        [integration.credential.header]: credential,
        ...(args.contentType ? { 'content-type': args.contentType } : {}),
      },
      body: args.body,
    });
    if (response.status >= 300 && response.status < 400) throw new Error();
    const contentType = response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (
      args.method !== 'HEAD' &&
      response.status !== 204 &&
      (!contentType ||
        !(
          contentType.startsWith('text/') ||
          contentType === 'application/json' ||
          /^application\/[a-z0-9.+-]+\+json$/.test(contentType)
        ))
    )
      throw new Error();
    if (Number(response.headers.get('content-length')) > maxResponse)
      throw new Error();
    reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxResponse) throw new Error();
        chunks.push(chunk.value);
      }
    }
    const body = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'retry-after', 'x-request-id']) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    if (
      [body, ...Object.values(headers)].some(
        (value) => value.includes(secret) || value.includes(credential),
      )
    )
      throw new Error();
    complete = true;
    return { status: response.status, headers, body };
  } catch {
    // Undici errors can include destinations or request credentials. Never relay them.
    throw new Error(
      'Integration request failed: upstream unavailable or response rejected',
    );
  } finally {
    if (!complete) {
      await (reader ? reader.cancel() : response?.body?.cancel())?.catch(
        () => {},
      );
    }
    reader?.releaseLock();
    if (agent) await agent.destroy().catch(() => {});
    active--;
    const remaining = (scopes.get(scope) ?? 1) - 1;
    if (remaining) scopes.set(scope, remaining);
    else scopes.delete(scope);
  }
}
