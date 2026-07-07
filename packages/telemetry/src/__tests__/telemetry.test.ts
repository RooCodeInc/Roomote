import { describe, expect, it } from 'vitest';

import { PAGEVIEW_EVENT, TELEMETRY_EVENT_NAME_PATTERN } from '../index';
import { isTelemetryEnvAllowedFor } from '../server';

describe('isTelemetryEnvAllowedFor', () => {
  it('allows production releases', () => {
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'production',
        releaseVersion: 'v1.2.3',
        forceTelemetry: undefined,
      }),
    ).toBe(true);
  });

  it('allows preview releases', () => {
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'preview',
        releaseVersion: 'v1.2.3',
        forceTelemetry: undefined,
      }),
    ).toBe(true);
  });

  it('blocks development even with a release version', () => {
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'development',
        releaseVersion: 'v1.2.3',
        forceTelemetry: undefined,
      }),
    ).toBe(false);
  });

  it('blocks builds without a release version', () => {
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'production',
        releaseVersion: undefined,
        forceTelemetry: undefined,
      }),
    ).toBe(false);
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'production',
        releaseVersion: '   ',
        forceTelemetry: undefined,
      }),
    ).toBe(false);
  });

  it('force flag overrides every other gate', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes']) {
      expect(
        isTelemetryEnvAllowedFor({
          appEnv: 'development',
          releaseVersion: undefined,
          forceTelemetry: value,
        }),
      ).toBe(true);
    }
  });

  it('non-truthy force values do not enable telemetry', () => {
    for (const value of ['0', 'false', '', undefined]) {
      expect(
        isTelemetryEnvAllowedFor({
          appEnv: 'development',
          releaseVersion: undefined,
          forceTelemetry: value,
        }),
      ).toBe(false);
    }
  });
});

describe('TELEMETRY_EVENT_NAME_PATTERN', () => {
  it('accepts snake case and PostHog-style event names', () => {
    expect(TELEMETRY_EVENT_NAME_PATTERN.test('task_created')).toBe(true);
    expect(TELEMETRY_EVENT_NAME_PATTERN.test(PAGEVIEW_EVENT)).toBe(true);
    expect(TELEMETRY_EVENT_NAME_PATTERN.test('setup_completed')).toBe(true);
  });

  it('rejects names that could smuggle arbitrary content', () => {
    expect(TELEMETRY_EVENT_NAME_PATTERN.test('Task Created')).toBe(false);
    expect(TELEMETRY_EVENT_NAME_PATTERN.test('')).toBe(false);
    expect(TELEMETRY_EVENT_NAME_PATTERN.test('a'.repeat(120))).toBe(false);
    expect(TELEMETRY_EVENT_NAME_PATTERN.test('drop;table')).toBe(false);
  });
});
