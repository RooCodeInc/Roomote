import { asRecord, asString } from '@roomote/types';

type AcpClientMessageIdCarrier = {
  payload?: unknown;
  metadata?: unknown;
};

export function getAcpClientMessageId(
  source: AcpClientMessageIdCarrier,
): string | null {
  const payload = asRecord(source.payload);
  const metadata = asRecord(source.metadata);

  return (
    asString(payload?.clientMessageId) ??
    asString(metadata?.clientMessageId) ??
    null
  );
}
