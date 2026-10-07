import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redactToolData } from './redact-secrets';
import { secretRedactor } from '@roomote/types';

const previousRef = '518f4f3074d5c69c9eb790e317352434cc5c60b8';
const parts = ['fixture-segment-a', 'fixture-segment-b', 'fixture-segment-c'];
const fixtureValue = parts.join(' ');
const cases = [
  ...[
    'password',
    'secret',
    'token',
    'api_key',
    'database_url',
    'private_key',
    'cookie',
    'credentials',
    'connection_string',
  ].map((key) => ({
    label: `multiword ${key}`,
    input: `diagnostic ${key}: ${fixtureValue}\nstatus: online`,
    probes: parts,
  })),
  ...[
    'passwordHint',
    'secret_value',
    'token_data',
    'authorizationValue',
    'credential_note',
    'api-key-label',
    'private_key_info',
  ].map((key) => ({
    label: `credential label continuation ${key}`,
    input: `diagnostic ${key}: ${fixtureValue}\nstatus: online`,
    probes: parts,
  })),
  {
    label: 'quoted spaced credential label',
    input: `diagnostic "client token": ${fixtureValue}\nstatus: online`,
    probes: parts,
  },
  {
    label: 'quoted multiword value control',
    input: `diagnostic password: "${fixtureValue}"\nstatus: online`,
    probes: parts,
  },
  {
    label: 'numbered credential label',
    input: `12: password: ${fixtureValue}\nstatus: online`,
    probes: parts,
  },
  {
    label: 'tab-separated value',
    input: `diagnostic password:\t${parts.join('\t')}\nstatus: online`,
    probes: parts,
  },
  {
    label: 'CRLF value boundary',
    input: `diagnostic password: ${fixtureValue}\r\nstatus: online`,
    probes: parts,
  },
  {
    label: 'GitHub classic continuation alphabet',
    input: `diagnostic ghp_${'A1b2'.repeat(4)}_fixture-tail-sensitive\nstatus: online`,
    probes: ['fixture-tail-sensitive'],
  },
  {
    label: 'GitHub fine-grained continuation alphabet',
    input: `diagnostic github_pat_${'A1b2'.repeat(4)}-fixture-tail-sensitive\nstatus: online`,
    probes: ['fixture-tail-sensitive'],
  },
  {
    label: 'Slack continuation alphabet',
    input: `diagnostic xoxb-${'A1b2'.repeat(4)}_fixture-tail-sensitive\nstatus: online`,
    probes: ['fixture-tail-sensitive'],
  },
  {
    label: 'legacy private-key label alphabet',
    input:
      'diagnostic -----BEGIN lower_case PRIVATE KEY-----\nfixture-private-sensitive\n-----END lower_case PRIVATE KEY-----\nstatus: online',
    probes: ['fixture-private-sensitive'],
  },
];

let tempDir: string;
let previous: { redactToolData: typeof redactToolData };
beforeAll(async () => {
  tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'roomote-diagnostic-differential-'),
  );
  const snapshotPath = path.join(tempDir, 'immutable-redactor.ts');
  const source = execFileSync(
    'git',
    ['show', `${previousRef}:packages/communication/src/redact-secrets.ts`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  fs.writeFileSync(snapshotPath, source);
  previous = await import(/* @vite-ignore */ pathToFileURL(snapshotPath).href);
});
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe('diagnostic acceptance differential against immutable518f4f30', () => {
  it.each(cases)('does not narrow masking: $label', ({ input, probes }) => {
    const oldOutput = previous.redactToolData(input);
    const currentOutput = redactToolData(input);
    expect(probes.some((probe) => oldOutput.includes(probe))).toBe(false);
    expect(probes.some((probe) => currentOutput.includes(probe))).toBe(false);
    expect(currentOutput.includes('status: online')).toBe(true);
  });
  it('retains structured metadata and unbounded content controls', () => {
    const input = {
      tokenCount: 42,
      output: 'n'.repeat(20_000),
      items: Array.from({ length: 80 }, (_, id) => ({ id })),
      pm2_env: {
        status: 'online',
        restart_time: 3,
        custom_setting: fixtureValue,
      },
    };
    const oldOutput = previous.redactToolData(input);
    const currentOutput = redactToolData(input);
    for (const output of [oldOutput, currentOutput]) {
      expect(output.tokenCount).toBe(42);
      expect(output.output === input.output).toBe(true);
      expect(output.items.length).toBe(80);
      expect(output.pm2_env.status).toBe('online');
      expect(output.pm2_env.restart_time).toBe(3);
      expect(output.pm2_env.custom_setting.includes(parts[0]!)).toBe(false);
    }
  });
  it('keeps shared non-diagnostic assignment and value-recognition policies unchanged', () => {
    const text = `password: ${fixtureValue}\nstatus: online`;
    const logOutput = secretRedactor.maskText(text, {
      policy: 'log',
      namedAssignments: true,
    });
    expect(logOutput.includes(parts[0]!)).toBe(false);
    expect(logOutput.includes(parts[1]!)).toBe(true);
    expect(logOutput.includes(parts[2]!)).toBe(true);
    const prose = 'Discuss token generation and Basic authentication design.';
    expect(secretRedactor.maskText(prose, { policy: 'brain' }) === prose).toBe(
      true,
    );
    expect(
      secretRedactor.maskText(prose, { policy: 'published' }) === prose,
    ).toBe(true);
    expect(secretRedactor.isSensitiveKey('passwordHint', 'diagnostic')).toBe(
      false,
    );
    expect(
      secretRedactor.isSensitiveKey('passwordHint', 'diagnostic-text'),
    ).toBe(true);
  });
});
