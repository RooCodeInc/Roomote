import {
  SETUP_RECEIPT_INPUT_KIND,
  type SetupReceiptPayload,
  type AcpRequestUserInputResponsePayload,
} from '@roomote/types';

type SetupReceiptMessage = {
  metadata: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
};

function getCanonicalSetupReceipt(
  message: SetupReceiptMessage,
): SetupReceiptPayload | null {
  if (message.metadata?.inputKind !== SETUP_RECEIPT_INPUT_KIND) return null;
  const receipt = message.payload?.setupReceipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return null;
  }
  const kind = (receipt as Record<string, unknown>).kind;
  return typeof kind === 'string' ? (receipt as SetupReceiptPayload) : null;
}

/**
 * Returns true only when a canonical receipt explicitly represents the same
 * request-user-input action. Presets are presentation hints, not an
 * association: responses without a linked receipt must remain visible.
 */
export function isRequestUserInputResponseRepresentedByCanonicalReceipt(
  response: AcpRequestUserInputResponsePayload,
  messages: readonly SetupReceiptMessage[],
): boolean {
  return messages.some(
    (message) =>
      getCanonicalSetupReceipt(message)?.requestId === response.requestId,
  );
}
