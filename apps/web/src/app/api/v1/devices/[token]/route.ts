import { z } from 'zod';

import { and, db, eq, userDevices } from '@roomote/db/server';
import {
  USER_DEVICE_ENVIRONMENTS,
  USER_DEVICE_PLATFORMS,
  type UserDevicePushCategories,
} from '@roomote/types';

import {
  ApiV1Error,
  jsonOk,
  readJsonBody,
  withApiV1Auth,
} from '@/lib/server/api-v1';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** APNs device tokens are hex; keep a wide bound rather than pin 64 chars. */
const tokenSchema = z.string().regex(/^[0-9a-fA-F]{16,512}$/);

const bodySchema = z.object({
  platform: z.enum(USER_DEVICE_PLATFORMS),
  environment: z.enum(USER_DEVICE_ENVIRONMENTS),
  bundleId: z.string().trim().min(1).max(200),
  appVersion: z.string().trim().max(100).optional(),
  deviceName: z.string().trim().max(200).optional(),
  categories: z
    .object({
      user_input: z.boolean(),
      capability_offer: z.boolean(),
      task_settled: z.boolean(),
      reply: z.boolean(),
    } satisfies Record<keyof UserDevicePushCategories, z.ZodBoolean>)
    .optional(),
});

function parseToken(raw: string): string {
  const token = tokenSchema.safeParse(raw);
  if (!token.success) throw new ApiV1Error('Invalid device token', 400);
  return token.data.toLowerCase();
}

/**
 * Register (or refresh) the caller's device for push. Keyed by
 * (platform, token): a phone that signs in as someone else moves over, and
 * a token APNs previously reported gone is re-enabled.
 */
export const PUT = withApiV1Auth<{ token: string }>(
  async ({ request, auth, params }) => {
    const token = parseToken(params.token);
    const input = await readJsonBody(request, bodySchema);
    const now = new Date();
    const values = {
      userId: auth.userId,
      environment: input.environment,
      bundleId: input.bundleId,
      appVersion: input.appVersion ?? null,
      deviceName: input.deviceName ?? null,
      lastSeenAt: now,
      disabledAt: null,
      updatedAt: now,
    };
    await db
      .insert(userDevices)
      .values({
        ...values,
        platform: input.platform,
        token,
        ...(input.categories ? { categories: input.categories } : {}),
      })
      .onConflictDoUpdate({
        target: [userDevices.platform, userDevices.token],
        set: {
          ...values,
          ...(input.categories ? { categories: input.categories } : {}),
        },
      });
    return jsonOk({ success: true });
  },
);

export const DELETE = withApiV1Auth<{ token: string }>(
  async ({ auth, params }) => {
    const token = parseToken(params.token);
    await db
      .delete(userDevices)
      .where(
        and(eq(userDevices.token, token), eq(userDevices.userId, auth.userId)),
      );
    return jsonOk({ success: true });
  },
);
