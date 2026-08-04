/**
 * A chat delivery endpoint rejected the post. Carries the platform API's
 * structured retryability verdict and provider error code so callers can act
 * on fields instead of matching on message wording.
 */
export class ChatDeliveryError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly providerErrorCode?: string;

  constructor(input: {
    message: string;
    status: number;
    retryable: boolean;
    providerErrorCode?: string;
  }) {
    super(input.message);
    this.name = 'ChatDeliveryError';
    this.status = input.status;
    this.retryable = input.retryable;
    this.providerErrorCode = input.providerErrorCode;
  }
}

interface ChatDeliveryFailure {
  retryable: boolean;
  providerErrorCode?: string;
}

/**
 * Describes a failed delivery attempt. Errors without a structured verdict
 * default to retryable; the bounded attempt budget in the satisfaction state
 * still caps how long that optimism lasts.
 */
export function describeChatDeliveryFailure(
  error: unknown,
): ChatDeliveryFailure {
  if (error instanceof ChatDeliveryError) {
    return {
      retryable: error.retryable,
      ...(error.providerErrorCode
        ? { providerErrorCode: error.providerErrorCode }
        : {}),
    };
  }

  return { retryable: true };
}
