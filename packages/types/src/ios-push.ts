/**
 * Push-notification categories the Roomote iOS app can receive. Each maps to
 * an APNs `category` (the uppercased kind) so the app can attach actions.
 */
export const IOS_PUSH_KINDS = [
  'user_input',
  'capability_offer',
  'task_settled',
  'reply',
] as const;

export type IosPushKind = (typeof IOS_PUSH_KINDS)[number];

/** Per-device opt-in flags, one per push kind. Missing keys mean enabled. */
export type UserDevicePushCategories = Record<IosPushKind, boolean>;

export const DEFAULT_USER_DEVICE_PUSH_CATEGORIES: UserDevicePushCategories = {
  user_input: true,
  capability_offer: true,
  task_settled: true,
  reply: true,
};

export const USER_DEVICE_PLATFORMS = ['ios'] as const;
export type UserDevicePlatform = (typeof USER_DEVICE_PLATFORMS)[number];

export const USER_DEVICE_ENVIRONMENTS = ['production', 'sandbox'] as const;
export type UserDeviceEnvironment = (typeof USER_DEVICE_ENVIRONMENTS)[number];

export function isIosPushKind(value: unknown): value is IosPushKind {
  return (
    typeof value === 'string' &&
    (IOS_PUSH_KINDS as readonly string[]).includes(value)
  );
}
