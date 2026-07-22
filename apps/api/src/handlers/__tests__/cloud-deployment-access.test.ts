import { createHmac } from 'node:crypto';

import { verifyManagedAccessDecisionToken } from '../cloud-deployment-access';

const VECTOR_DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';
const VECTOR_VERIFICATION_SECRET =
  '-sPppCu0t_2NHcLe_6pomNZ19cGNL3YWc5IUWODRTP8';
const VECTOR_TOKEN =
  'rcda1.eyJpc3MiOiJyb29tb3RlLWNsb3VkIiwiYXVkIjoiMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExIiwic3RhdGUiOiJyZWFkX29ubHkiLCJyZWFzb24iOiJiaWxsaW5nX3JlcXVpcmVkIiwicmV2aXNpb24iOjcsImVmZmVjdGl2ZUF0IjoiMjAyNi0wNy0yNFQxMjowMDowMC4wMDBaIiwicmVzdHJpY3Rpb25TdGFydHNBdCI6bnVsbCwicmVtZWRpYXRpb25VcmwiOiJodHRwczovL2Nsb3VkLnJvb21vdGUudGVzdC8jYmlsbGluZyIsImlhdCI6MTc4NDg5NDQwMCwiZXhwIjoxNzg0ODk0NDYwfQ.P3os3xrRhW_25izIbUSz7njAoxfmmpzjH9QtW7sjvzs';

function signDecision(payload: Record<string, unknown>): string {
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const signature = createHmac(
    'sha256',
    Buffer.from(VECTOR_VERIFICATION_SECRET, 'base64url'),
  )
    .update(`rcda1.${payloadSegment}`, 'ascii')
    .digest('base64url');

  return `rcda1.${payloadSegment}.${signature}`;
}

describe('verifyManagedAccessDecisionToken', () => {
  it('verifies the shared conformance vector exactly', () => {
    const decision = verifyManagedAccessDecisionToken(VECTOR_TOKEN, {
      deploymentId: VECTOR_DEPLOYMENT_ID,
      verificationSecret: VECTOR_VERIFICATION_SECRET,
      now: new Date('2026-07-24T12:00:30.000Z'),
    });

    expect(decision).toEqual({
      iss: 'roomote-cloud',
      aud: VECTOR_DEPLOYMENT_ID,
      state: 'read_only',
      reason: 'billing_required',
      revision: 7,
      effectiveAt: '2026-07-24T12:00:00.000Z',
      restrictionStartsAt: null,
      remediationUrl: 'https://cloud.roomote.test/#billing',
      iat: 1784894400,
      exp: 1784894460,
    });
  });

  it('fails closed for tampering, expiry, future iat, wrong audience, and invalid combinations', () => {
    expect(
      verifyManagedAccessDecisionToken(`${VECTOR_TOKEN.slice(0, -1)}a`, {
        deploymentId: VECTOR_DEPLOYMENT_ID,
        verificationSecret: VECTOR_VERIFICATION_SECRET,
        now: new Date('2026-07-24T12:00:30.000Z'),
      }),
    ).toBeNull();

    expect(
      verifyManagedAccessDecisionToken(VECTOR_TOKEN, {
        deploymentId: VECTOR_DEPLOYMENT_ID,
        verificationSecret: VECTOR_VERIFICATION_SECRET,
        now: new Date('2026-07-24T12:02:00.000Z'),
      }),
    ).toBeNull();

    expect(
      verifyManagedAccessDecisionToken(VECTOR_TOKEN, {
        deploymentId: VECTOR_DEPLOYMENT_ID,
        verificationSecret: VECTOR_VERIFICATION_SECRET,
        now: new Date('2026-07-24T11:58:00.000Z'),
      }),
    ).toBeNull();

    expect(
      verifyManagedAccessDecisionToken(VECTOR_TOKEN, {
        deploymentId: '22222222-2222-4222-8222-222222222222',
        verificationSecret: VECTOR_VERIFICATION_SECRET,
        now: new Date('2026-07-24T12:00:30.000Z'),
      }),
    ).toBeNull();

    const basePayload = {
      iss: 'roomote-cloud',
      aud: VECTOR_DEPLOYMENT_ID,
      state: 'read_only',
      reason: 'billing_required',
      revision: 7,
      effectiveAt: '2026-07-24T12:00:00.000Z',
      restrictionStartsAt: null,
      remediationUrl: 'https://cloud.roomote.test/#billing',
      iat: 1784894400,
      exp: 1784894460,
    };

    expect(
      verifyManagedAccessDecisionToken(
        signDecision({ ...basePayload, state: 'read_only', reason: null }),
        {
          deploymentId: VECTOR_DEPLOYMENT_ID,
          verificationSecret: VECTOR_VERIFICATION_SECRET,
          now: new Date('2026-07-24T12:00:30.000Z'),
        },
      ),
    ).toBeNull();

    expect(
      verifyManagedAccessDecisionToken(
        signDecision({
          ...basePayload,
          remediationUrl: 'http://cloud.roomote.test/#billing',
        }),
        {
          deploymentId: VECTOR_DEPLOYMENT_ID,
          verificationSecret: VECTOR_VERIFICATION_SECRET,
          now: new Date('2026-07-24T12:00:30.000Z'),
        },
      ),
    ).toBeNull();
  });
});
