import { asRecord, asString } from './primitives';

export const MODEL_SWITCH_NOTICE_PAYLOAD_KEY = 'modelSwitchNotice' as const;

/**
 * Why the model changed mid-run. `user` is an explicit operator action;
 * `failover` is reserved for automatic provider fallback so the transcript can
 * distinguish a deliberate change from a recovery.
 */
export type ModelSwitchReason = 'user' | 'failover';

/**
 * Transcript record of a mid-run model change. Attached to an assistant
 * message so the change is visible in the task timeline rather than only in
 * worker logs. Clients that do not understand the payload still render the
 * message text.
 */
export type ModelSwitchNotice = {
  reason: ModelSwitchReason;
  /** Model that was active before the switch, when one was configured. */
  fromModel?: string;
  /** Model applied to subsequent turns. */
  toModel: string;
  /** Display name of the operator who requested a `user` switch. */
  requestedBy?: string;
};

export function isModelSwitchReason(
  value: unknown,
): value is ModelSwitchReason {
  return value === 'user' || value === 'failover';
}

export function parseModelSwitchNotice(
  value: unknown,
): ModelSwitchNotice | null {
  const record = asRecord(value);

  if (!record || !isModelSwitchReason(record.reason)) {
    return null;
  }

  const toModel = asString(record.toModel)?.trim();

  if (!toModel) {
    return null;
  }

  const fromModel = asString(record.fromModel)?.trim();
  const requestedBy = asString(record.requestedBy)?.trim();

  return {
    reason: record.reason,
    toModel,
    ...(fromModel ? { fromModel } : {}),
    ...(requestedBy ? { requestedBy } : {}),
  };
}

export function getModelSwitchNoticeFromMessageData(
  data: Record<string, unknown> | null | undefined,
): ModelSwitchNotice | null {
  if (!data) {
    return null;
  }

  return parseModelSwitchNotice(data[MODEL_SWITCH_NOTICE_PAYLOAD_KEY]);
}

export function formatModelSwitchNoticeText(notice: ModelSwitchNotice): string {
  const target = `\`${notice.toModel}\``;

  if (notice.reason === 'failover') {
    return notice.fromModel
      ? `Switched from \`${notice.fromModel}\` to ${target} after a provider failure.`
      : `Switched to ${target} after a provider failure.`;
  }

  const attribution = notice.requestedBy ? ` by ${notice.requestedBy}` : '';

  return notice.fromModel
    ? `Model changed${attribution} from \`${notice.fromModel}\` to ${target}.`
    : `Model changed${attribution} to ${target}.`;
}
