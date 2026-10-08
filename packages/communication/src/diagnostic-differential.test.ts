import { describe, it, expect } from 'vitest';
import { redactToolData } from './redact-secrets';
import { secretRedactor } from '@roomote/types';
import * as previous from './__fixtures__/diagnostic-redactor-518f4f30';
import {
  diagnosticProbes,
  generatedDiagnosticTextCases,
  generatedRelatedExceptionCases,
  generatedPm2ArrayCases,
} from './__fixtures__/diagnostic-generated-cases';

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

describe('diagnostic acceptance differential against immutable518f4f30', () => {
  it('retains masking across generated label/separator/quoting/line-ending combinations', () => {
    const generated = generatedDiagnosticTextCases();
    const failures: Record<string, number> = {};
    for (const { label, input } of generated) {
      const oldOutput = previous.redactToolData(input);
      const currentOutput = redactToolData(input);
      if (
        diagnosticProbes.some(
          (probe) =>
            !oldOutput.includes(probe) && currentOutput.includes(probe),
        )
      )
        failures[label] = (failures[label] ?? 0) + 1;
      expect(currentOutput.includes('status: online')).toBe(true);
    }
    expect(generated.length).toBe(4320);
    // Only labels and counts appear on failure, never fixture values/output.
    expect(failures).toEqual({});
  });
  it('preserves generated nearby contracts without inheriting the legacy PM2 array leak', () => {
    const generated = generatedRelatedExceptionCases();
    const failures: Record<string, number> = {};
    for (const { category, input, secretValues } of generated) {
      const current = JSON.stringify(redactToolData(input, secretValues));
      // These four inherited legacy cases must prove safety, not leak parity.
      if (category === 'pm2-array') {
        if (
          diagnosticProbes.some((probe) => current.includes(probe)) ||
          !current.includes('[redacted]')
        )
          failures[category] = (failures[category] ?? 0) + 1;
        continue;
      }
      if (
        current !== JSON.stringify(previous.redactToolData(input, secretValues))
      )
        failures[category] = (failures[category] ?? 0) + 1;
    }
    expect(generated.length).toBe(301);
    expect(failures).toEqual({});
  });
  it('redacts array-shaped PM2 context while preserving only typed safe metadata', () => {
    const generated = generatedPm2ArrayCases();
    for (const { input, expectedPm2 } of generated) {
      const before = JSON.stringify(input);
      const output = redactToolData(input);
      expect(
        JSON.stringify(output.pm2_env) === JSON.stringify(expectedPm2),
      ).toBe(true);
      expect(
        JSON.stringify(output.pm2_env).includes(diagnosticProbes[0]!),
      ).toBe(false);
      expect(output.tokenCount).toBe(42);
      expect(output.output === input.output).toBe(true);
      expect(JSON.stringify(output.items) === JSON.stringify(input.items)).toBe(
        true,
      );
      expect(JSON.stringify(input) === before).toBe(true);
    }
    expect(generated.length).toBe(18);
  });
  it('masks tokenCount diagnostic text while preserving numeric structure and other policies', () => {
    const input = `diag tokenCount: ${fixtureValue}\nstatus: online`;
    expect(parts.some((part) => redactToolData(input).includes(part))).toBe(
      false,
    );
    expect(redactToolData({ tokenCount: 42 }).tokenCount).toBe(42);
    expect(
      JSON.parse(redactToolData(JSON.stringify({ tokenCount: 42 }))).tokenCount,
    ).toBe(42);
    for (const policy of [
      'diagnostic',
      'integration',
      'webhook',
      'environment',
    ] as const)
      expect(secretRedactor.isSensitiveKey('tokenCount', policy)).toBe(false);
    for (const policy of ['log', 'published', 'brain'] as const)
      expect(
        secretRedactor.maskText(input, { policy, namedAssignments: true }) ===
          input,
      ).toBe(true);
  });
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
