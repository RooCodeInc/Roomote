#!/usr/bin/env node
// Roomote license key tooling for the licensor. Self-hosters do not need
// this: deployments are free up to the seat limit in
// apps/web/src/lib/server/license.ts, and larger deployments need a key
// issued by the Roomote maintainers (the Ed25519 private key never lives in
// this repository).
//
//   node scripts/license.mjs keygen <private-key.pem>
//   node scripts/license.mjs issue --key <private-key.pem> --licensee "Acme Corp" --seats 50 [--expires 2027-07-07]
//   node scripts/license.mjs inspect <license-key>

import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const LICENSE_KEY_PREFIX = 'RMLK1';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};

  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      fail(`Unexpected argument: ${argv[i]}`);
    }

    flags[argv[i].slice(2)] = argv[i + 1];
  }

  return flags;
}

function keygen(path) {
  if (!path) {
    fail('Usage: license.mjs keygen <private-key.pem>');
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });

  console.log(`Private key written to ${path} (keep it out of the repo).`);
  console.log(
    `Public key (LICENSE_PUBLIC_KEY_SPKI_B64): ${publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64')}`,
  );
}

function issue(flags) {
  const seats = Number(flags.seats);

  if (!flags.key || !flags.licensee || !Number.isInteger(seats) || seats < 1) {
    fail(
      'Usage: license.mjs issue --key <private-key.pem> --licensee <name> --seats <n> [--expires <ISO date>] [--id <license id>]',
    );
  }

  const expiresAt = flags.expires ? new Date(flags.expires) : null;

  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    fail(`Invalid --expires date: ${flags.expires}`);
  }

  const payload = {
    licenseId: flags.id ?? `lic_${randomBytes(6).toString('hex')}`,
    licensee: flags.licensee,
    maxSeats: seats,
    issuedAt: new Date().toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };

  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const privateKey = createPrivateKey(readFileSync(flags.key, 'utf8'));
  const signature = sign(null, payloadBytes, privateKey);

  console.log(
    `${LICENSE_KEY_PREFIX}.${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`,
  );
}

function inspect(licenseKey) {
  const [prefix, payloadB64] = (licenseKey ?? '').trim().split('.');

  if (prefix !== LICENSE_KEY_PREFIX || !payloadB64) {
    fail('Not a Roomote license key.');
  }

  console.log(
    JSON.stringify(
      JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')),
      null,
      2,
    ),
  );
  console.log(
    '(payload decoded without signature verification — the app verifies on save)',
  );
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'keygen':
    keygen(rest[0]);
    break;
  case 'issue':
    issue(parseFlags(rest));
    break;
  case 'inspect':
    inspect(rest[0]);
    break;
  default:
    fail('Usage: license.mjs <keygen|issue|inspect> ...');
}
