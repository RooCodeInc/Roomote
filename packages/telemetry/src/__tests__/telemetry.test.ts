import { describe, expect, it, vi } from 'vitest';

import {
  buildActivationPrMergedProperties,
  buildActivationTaskProperties,
  PAGEVIEW_EVENT,
  TELEMETRY_EVENT_NAME_PATTERN,
} from '../index';
import {
  getTelemetryConfigurationNotice,
  isTelemetryEnvAllowedFor,
  logTelemetryConfigurationNotice,
} from '../server';

describe('isTelemetryEnvAllowedFor', () => {
  it('allows production releases', () => {
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'production',
        releaseVersion: 'v1.2.3',
        forceTelemetry: undefined,
        pingBaseUrl: undefined,
      }),
    ).toBe(true);
  });

  it('blocks preview releases', () => {
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'preview',
        releaseVersion: 'v1.2.3',
        forceTelemetry: undefined,
        pingBaseUrl: undefined,
      }),
    ).toBe(false);
  });

  it('blocks development even with a release version', () => {
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'development',
        releaseVersion: 'v1.2.3',
        forceTelemetry: undefined,
        pingBaseUrl: undefined,
      }),
    ).toBe(false);
  });

  it('blocks builds without a release version', () => {
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'production',
        releaseVersion: undefined,
        forceTelemetry: undefined,
        pingBaseUrl: undefined,
      }),
    ).toBe(false);
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'production',
        releaseVersion: '   ',
        forceTelemetry: undefined,
        pingBaseUrl: undefined,
      }),
    ).toBe(false);
  });

  it('force flag enables telemetry when a Ping endpoint is explicitly configured', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes']) {
      expect(
        isTelemetryEnvAllowedFor({
          appEnv: 'development',
          releaseVersion: undefined,
          forceTelemetry: value,
          pingBaseUrl: 'https://ping-preview.roomote.dev',
        }),
      ).toBe(true);
    }
  });

  it('force flag does not use the default Ping endpoint outside production', () => {
    expect(
      isTelemetryEnvAllowedFor({
        appEnv: 'preview',
        releaseVersion: 'v1.2.3',
        forceTelemetry: 'true',
        pingBaseUrl: undefined,
      }),
    ).toBe(false);
  });

  it('non-truthy force values do not enable telemetry', () => {
    for (const value of ['0', 'false', '', undefined]) {
      expect(
        isTelemetryEnvAllowedFor({
          appEnv: 'development',
          releaseVersion: undefined,
          forceTelemetry: value,
          pingBaseUrl: 'https://ping-preview.roomote.dev',
        }),
      ).toBe(false);
    }
  });
});

describe('getTelemetryConfigurationNotice', () => {
  it('notices a Ping endpoint without the non-production force flag', () => {
    expect(
      getTelemetryConfigurationNotice({
        appEnv: 'preview',
        releaseVersion: 'v1.2.3',
        forceTelemetry: undefined,
        pingBaseUrl: 'https://ping-preview.roomote.dev',
      }),
    ).toContain('ROOMOTE_FORCE_TELEMETRY=true');
  });

  it('notices a non-production force flag without an explicit Ping endpoint', () => {
    expect(
      getTelemetryConfigurationNotice({
        appEnv: 'development',
        releaseVersion: undefined,
        forceTelemetry: 'true',
        pingBaseUrl: undefined,
      }),
    ).toContain('R_PING_BASE_URL');
  });

  it('does not notice complete or production configurations', () => {
    expect(
      getTelemetryConfigurationNotice({
        appEnv: 'preview',
        releaseVersion: 'v1.2.3',
        forceTelemetry: 'true',
        pingBaseUrl: 'https://ping-preview.roomote.dev',
      }),
    ).toBeNull();
    expect(
      getTelemetryConfigurationNotice({
        appEnv: 'production',
        releaseVersion: 'v1.2.3',
        forceTelemetry: undefined,
        pingBaseUrl: 'https://ping.roomote.dev',
      }),
    ).toBeNull();
  });

  it('logs each partial configuration notice only once', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const input of [
      {
        appEnv: 'preview',
        releaseVersion: 'v1.2.3',
        forceTelemetry: undefined,
        pingBaseUrl: 'https://ping-preview.roomote.dev',
      },
      {
        appEnv: 'development',
        releaseVersion: undefined,
        forceTelemetry: 'true',
        pingBaseUrl: undefined,
      },
    ]) {
      logTelemetryConfigurationNotice(input);
      logTelemetryConfigurationNotice(input);
    }

    expect(info).toHaveBeenCalledTimes(2);
    info.mockRestore();
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

describe('activation event properties', () => {
  it('allows only safe task routing classifications', () => {
    expect(
      buildActivationTaskProperties({
        workflow: 'standard',
        surface: 'slack',
        trigger: 'message',
        harness: 'opencode',
        model: 'gpt-5',
        computeProvider: 'modal',
      }),
    ).toEqual({
      workflow: 'standard',
      surface: 'slack',
      trigger: 'message',
      harness: 'opencode',
      model: 'gpt-5',
      computeProvider: 'modal',
    });
  });

  it('allows only provider and task classifications for merged PRs', () => {
    expect(
      buildActivationPrMergedProperties({
        provider: 'github',
        workflow: 'standard',
        surface: 'web',
      }),
    ).toEqual({ provider: 'github', workflow: 'standard', surface: 'web' });
  });
});
