/**
 * Slack error codes for chat.postMessage that cannot succeed by retrying the
 * same request against the same target: the channel is gone or inaccessible,
 * or the installation's credentials are dead. Content-dependent errors such
 * as `msg_too_long` and `invalid_blocks` are deliberately excluded — a
 * rewritten message can still go through.
 */
const NON_RETRYABLE_SLACK_POST_ERROR_CODES = new Set([
  'account_inactive',
  'channel_not_found',
  'ekm_access_denied',
  'invalid_auth',
  'is_archived',
  'messages_tab_disabled',
  'no_permission',
  'not_in_channel',
  'org_login_required',
  'restricted_action',
  'team_access_not_granted',
  'token_expired',
  'token_revoked',
]);

export function isNonRetryableSlackPostErrorCode(
  code: string | undefined,
): boolean {
  return code !== undefined && NON_RETRYABLE_SLACK_POST_ERROR_CODES.has(code);
}

/**
 * A chat.postMessage attempt failed. Carries the structured Slack error code
 * (or transport-failure flag) so API handlers can report retryability to the
 * calling agent instead of collapsing every failure into a generic 502.
 */
export class SlackPostDeliveryError extends Error {
  readonly slackErrorCode?: string;
  readonly transportError: boolean;

  constructor(result: { slackErrorCode?: string; transportError?: boolean }) {
    super(
      `Slack chat.postMessage failed: ${
        result.slackErrorCode ??
        (result.transportError ? 'transport error' : 'unknown error')
      }`,
    );
    this.name = 'SlackPostDeliveryError';
    this.slackErrorCode = result.slackErrorCode;
    this.transportError = result.transportError === true;
  }

  get retryable(): boolean {
    return (
      this.transportError ||
      !isNonRetryableSlackPostErrorCode(this.slackErrorCode)
    );
  }
}
