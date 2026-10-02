import { createHmac, timingSafeEqual } from 'node:crypto';

const CAPABILITY_VERSION = 'rcq1';

function capabilityMac(input: {
  runToken: string;
  expiresAtMs: number;
  signingKey: string;
}): Buffer {
  return createHmac('sha256', input.signingKey)
    .update(`${CAPABILITY_VERSION}:${input.expiresAtMs}:${input.runToken}`)
    .digest();
}

export function createCritiqueSubmissionCapability(input: {
  runToken: string;
  expiresAtMs: number;
  signingKey: string;
}): string {
  if (
    !Number.isSafeInteger(input.expiresAtMs) ||
    input.expiresAtMs <= Date.now()
  ) {
    throw new Error('Critique capability expiry must be in the future');
  }
  const mac = capabilityMac(input).toString('base64url');
  return `${CAPABILITY_VERSION}.${input.expiresAtMs}.${mac}`;
}

export function validateCritiqueSubmissionCapability(input: {
  capability: string | undefined;
  runToken: string;
  signingKeys: readonly string[];
  nowMs?: number;
}): boolean {
  if (!input.capability || !input.runToken || input.signingKeys.length === 0) {
    return false;
  }
  const [version, rawExpiry, rawMac, ...extra] = input.capability.split('.');
  if (version !== CAPABILITY_VERSION || !rawExpiry || !rawMac || extra.length) {
    return false;
  }
  const expiresAtMs = Number(rawExpiry);
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= (input.nowMs ?? Date.now())
  ) {
    return false;
  }
  let actualMac: Buffer;
  try {
    actualMac = Buffer.from(rawMac, 'base64url');
  } catch {
    return false;
  }
  return input.signingKeys.some((signingKey) => {
    const expectedMac = capabilityMac({
      runToken: input.runToken,
      expiresAtMs,
      signingKey,
    });
    return (
      actualMac.length === expectedMac.length &&
      timingSafeEqual(actualMac, expectedMac)
    );
  });
}
