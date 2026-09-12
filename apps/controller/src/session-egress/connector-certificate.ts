import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Connector client-certificate issuer.
 *
 * The controller holds a small private CA (the gateway's
 * `SESSION_EGRESS_CLIENT_CA_FILE`) and mints one short-lived ECDSA P-256 leaf
 * per workload generation. The leaf carries exactly the two SAN URIs the
 * gateway's identity package reads:
 *
 *   - the connector identity, `spiffe://roomote/connector/<run>-<random>`
 *   - the workload binding, `roomote://workload/<workloadId>`
 *
 * The private key is generated here, written into the connector container
 * only, and forgotten. It never enters the worker container, a task payload,
 * a snapshot, or a log. Node has no X.509 builder and the controller image
 * has no guaranteed `openssl`, so the certificate is DER-encoded by hand;
 * the shape is the minimal RFC 5280 v3 profile Go's `crypto/x509` verifies.
 */

export interface ConnectorCertificateAuthority {
  certificatePem: string;
  privateKeyPem: string;
}

export interface IssuedConnectorCertificate {
  certificatePem: string;
  privateKeyPem: string;
  notBefore: Date;
  notAfter: Date;
  serialHex: string;
}

const CONNECTOR_IDENTITY_PREFIX = 'spiffe://roomote/connector/';
const WORKLOAD_URI_PREFIX = 'roomote://workload/';

/** Random per-generation identity; unique among active workloads by contract. */
export function buildConnectorIdentity(runId: number): string {
  return `${CONNECTOR_IDENTITY_PREFIX}${runId}-${randomBytes(12).toString('hex')}`;
}

export function loadConnectorCertificateAuthority(
  paths: { certificateFile: string; privateKeyFile: string },
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): ConnectorCertificateAuthority {
  return validateConnectorCertificateAuthority({
    certificatePem: readFile(paths.certificateFile),
    privateKeyPem: readFile(paths.privateKeyFile),
  });
}

/** Fail at load time, not at first spawn, when the pair is unusable. */
function validateConnectorCertificateAuthority(
  ca: ConnectorCertificateAuthority,
): ConnectorCertificateAuthority {
  const cert = new X509Certificate(ca.certificatePem);
  const key = createPrivateKey(ca.privateKeyPem);
  if (!cert.checkPrivateKey(key)) {
    throw new Error(
      'Session egress connector CA certificate does not match its private key',
    );
  }
  if (!cert.ca) {
    throw new Error(
      'Session egress connector CA certificate is not a CA certificate',
    );
  }
  if (
    Date.parse(cert.validFrom) > Date.now() ||
    Date.parse(cert.validTo) <= Date.now()
  ) {
    throw new Error('Session egress connector CA is not currently valid');
  }
  signatureAlgorithmFor(key);
  return ca;
}

export function issueConnectorCertificate(
  ca: ConnectorCertificateAuthority,
  input: {
    connectorIdentity: string;
    workloadId: string;
    validitySeconds: number;
    now?: Date;
  },
): IssuedConnectorCertificate {
  if (!input.connectorIdentity.startsWith(CONNECTOR_IDENTITY_PREFIX)) {
    throw new Error('connectorIdentity must be a spiffe-like connector URI');
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.workloadId,
    )
  ) {
    throw new Error('workloadId must be a UUID');
  }
  if (
    !Number.isInteger(input.validitySeconds) ||
    input.validitySeconds < 60 ||
    input.validitySeconds > 7 * 86_400
  ) {
    throw new Error('validitySeconds must be between 60 and 604800');
  }

  const caCert = new X509Certificate(ca.certificatePem);
  const caKey = createPrivateKey(ca.privateKeyPem);
  const signatureAlgorithm = signatureAlgorithmFor(caKey);

  const now = input.now ?? new Date();
  // Skew tolerance for connector hosts whose clock trails the controller.
  const notBefore = new Date(now.getTime() - 5 * 60 * 1_000);
  const notAfter = new Date(
    Math.min(
      now.getTime() + input.validitySeconds * 1_000,
      Date.parse(caCert.validTo),
    ),
  );
  if (
    notAfter.getTime() <= now.getTime() ||
    Date.parse(caCert.validFrom) > now.getTime()
  ) {
    throw new Error('Session egress connector CA is not currently valid');
  }

  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f; // positive, at most 128 bits

  const tbs = sequence([
    context(0, [derInteger(Buffer.from([0x02]))]), // version v3
    derInteger(serial),
    signatureAlgorithm,
    subjectNameOf(caCert), // issuer = CA subject, byte-exact
    sequence([derTime(notBefore), derTime(notAfter)]),
    sequence([
      set([
        sequence([
          oid('2.5.4.3'), // commonName
          der(0x0c, Buffer.from('roomote-session-egress-connector', 'utf8')),
        ]),
      ]),
    ]),
    publicKey.export({ type: 'spki', format: 'der' }),
    context(3, [
      sequence([
        extension('2.5.29.19', true, sequence([])), // basicConstraints: cA=false
        extension('2.5.29.15', true, der(0x03, Buffer.from([0x07, 0x80]))), // keyUsage: digitalSignature
        extension('2.5.29.37', false, sequence([oid('1.3.6.1.5.5.7.3.2')])), // extKeyUsage: clientAuth
        extension(
          '2.5.29.17',
          true,
          sequence([
            der(0x86, Buffer.from(input.connectorIdentity, 'ascii')),
            der(
              0x86,
              Buffer.from(
                `${WORKLOAD_URI_PREFIX}${input.workloadId.toLowerCase()}`,
                'ascii',
              ),
            ),
          ]),
        ),
      ]),
    ]),
  ]);

  const signature = sign('sha256', tbs, { key: caKey, dsaEncoding: 'der' });
  const certificate = sequence([
    tbs,
    signatureAlgorithm,
    der(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  ]);

  const certificatePem = toPem('CERTIFICATE', certificate);
  // Sanity: what we produced must parse and verify against the CA.
  const parsed = new X509Certificate(certificatePem);
  if (!parsed.verify(caCert.publicKey) || !parsed.checkIssued(caCert)) {
    throw new Error('Issued connector certificate failed self-verification');
  }

  return {
    certificatePem,
    privateKeyPem: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    notBefore,
    notAfter,
    serialHex: serial.toString('hex'),
  };
}

// ---- DER helpers -----------------------------------------------------------

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([tag]),
    derLength(content.length),
    content,
  ]);
}

function sequence(parts: Buffer[]): Buffer {
  return der(0x30, Buffer.concat(parts));
}

function set(parts: Buffer[]): Buffer {
  return der(0x31, Buffer.concat(parts));
}

function context(tagNumber: number, parts: Buffer[]): Buffer {
  return der(0xa0 | tagNumber, Buffer.concat(parts));
}

function derInteger(magnitude: Buffer): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1;
  let body = magnitude.subarray(start);
  if (body[0]! & 0x80) body = Buffer.concat([Buffer.from([0x00]), body]);
  return der(0x02, body);
}

function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map((arc) => Number(arc));
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    for (let n = Math.floor(arc / 128); n > 0; n = Math.floor(n / 128)) {
      chunk.unshift((n & 0x7f) | 0x80);
    }
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function derTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getUTCFullYear();
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  return year < 2050
    ? der(0x17, Buffer.from(`${String(year).slice(2)}${rest}`, 'ascii'))
    : der(0x18, Buffer.from(`${year}${rest}`, 'ascii'));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence([
    oid(id),
    ...(critical ? [der(0x01, Buffer.from([0xff]))] : []),
    der(0x04, value),
  ]);
}

function signatureAlgorithmFor(key: KeyObject): Buffer {
  switch (key.asymmetricKeyType) {
    case 'ec':
      return sequence([oid('1.2.840.10045.4.3.2')]); // ecdsa-with-SHA256
    case 'rsa':
      return sequence([
        oid('1.2.840.113549.1.1.11'),
        der(0x05, Buffer.alloc(0)),
      ]); // sha256WithRSAEncryption
    default:
      throw new Error(
        `Session egress connector CA key type ${String(key.asymmetricKeyType)} is not supported (use EC P-256 or RSA)`,
      );
  }
}

type Tlv = { tag: number; start: number; end: number; headerLength: number };

function readTlv(buffer: Buffer, offset: number): Tlv {
  const tag = buffer[offset]!;
  let length = buffer[offset + 1]!;
  let headerLength = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = length * 256 + buffer[offset + 2 + i]!;
    }
    headerLength = 2 + count;
  }
  const start = offset + headerLength;
  return { tag, start, end: start + length, headerLength };
}

/** The CA's Subject Name, copied byte-exact so Go's issuer matching succeeds. */
function subjectNameOf(cert: X509Certificate): Buffer {
  const raw = cert.raw;
  const certificate = readTlv(raw, 0);
  const tbs = readTlv(raw, certificate.start);
  let offset = tbs.start;
  let element = readTlv(raw, offset);
  if (element.tag === 0xa0) {
    offset = element.end; // version
    element = readTlv(raw, offset);
  }
  offset = element.end; // serialNumber
  offset = readTlv(raw, offset).end; // signature algorithm
  offset = readTlv(raw, offset).end; // issuer
  offset = readTlv(raw, offset).end; // validity
  const subject = readTlv(raw, offset);
  return raw.subarray(offset, subject.end);
}

function toPem(label: string, derBytes: Buffer): string {
  const lines = derBytes.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** Test/bootstrap helper: a self-signed EC connector CA. Not used at runtime. */
export function createSelfSignedConnectorCa(
  commonName = 'roomote-session-egress-connector-ca',
  validitySeconds = 365 * 86_400,
): ConnectorCertificateAuthority {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const now = new Date();
  const name = sequence([
    set([
      sequence([oid('2.5.4.3'), der(0x0c, Buffer.from(commonName, 'utf8'))]),
    ]),
  ]);
  const algorithm = signatureAlgorithmFor(privateKey);
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  const tbs = sequence([
    context(0, [derInteger(Buffer.from([0x02]))]),
    derInteger(serial),
    algorithm,
    name,
    sequence([
      derTime(new Date(now.getTime() - 60_000)),
      derTime(new Date(now.getTime() + validitySeconds * 1_000)),
    ]),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    context(3, [
      sequence([
        extension(
          '2.5.29.19',
          true,
          sequence([der(0x01, Buffer.from([0xff]))]),
        ), // cA=true
        extension('2.5.29.15', true, der(0x03, Buffer.from([0x01, 0x06]))), // keyCertSign|cRLSign
      ]),
    ]),
  ]);
  const signature = sign('sha256', tbs, {
    key: privateKey,
    dsaEncoding: 'der',
  });
  const certificate = sequence([
    tbs,
    algorithm,
    der(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  ]);
  return {
    certificatePem: toPem('CERTIFICATE', certificate),
    privateKeyPem: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  };
}
