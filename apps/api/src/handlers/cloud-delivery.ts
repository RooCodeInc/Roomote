import { createHmac, timingSafeEqual } from 'node:crypto';

const CLOUD_SIGNATURE_PREFIX = 'v2=';
const MAX_DELIVERY_AGE_SECONDS = 5 * 60;

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);

  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function verifyRoomoteCloudDelivery(input: {
  deliveryId: string;
  provider: 'github' | 'slack' | 'teams';
  eventName: string;
  payload: string;
  secret: string;
  signature: string;
  timestamp: string;
  nowSeconds?: number;
}): boolean {
  if (!/^\d+$/u.test(input.timestamp)) {
    return false;
  }

  const timestamp = Number(input.timestamp);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowSeconds - timestamp) > MAX_DELIVERY_AGE_SECONDS
  ) {
    return false;
  }

  const expected = `${CLOUD_SIGNATURE_PREFIX}${createHmac(
    'sha256',
    input.secret,
  )
    .update(
      `${input.timestamp}.${input.deliveryId}.${input.provider}.${input.eventName}.${input.payload}`,
    )
    .digest('hex')}`;

  return secureEqual(input.signature, expected);
}
