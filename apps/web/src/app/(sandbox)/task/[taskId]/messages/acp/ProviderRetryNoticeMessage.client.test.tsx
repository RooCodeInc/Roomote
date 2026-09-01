'use client';

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_RETRY_NOTICE_PAYLOAD_KEY } from '@roomote/types';

import { registerProviderRetryModelSwitcher } from '@/lib/provider-retry-model-switcher';

import { ProviderRetryNoticeMessage } from './ProviderRetryNoticeMessage';

describe('ProviderRetryNoticeMessage', () => {
  let unregisterModelSwitcher: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    unregisterModelSwitcher?.();
    unregisterModelSwitcher = undefined;
    vi.useRealTimers();
  });

  it('renders the provider error and a live countdown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

    const openModelSwitcher = vi.fn();
    unregisterModelSwitcher =
      registerProviderRetryModelSwitcher(openModelSwitcher);
    render(
      <ProviderRetryNoticeMessage
        text="ignored body"
        data={{
          [PROVIDER_RETRY_NOTICE_PAYLOAD_KEY]: {
            kind: 'rate_limit',
            attemptNumber: 1,
            maxAttempts: 3,
            delayMs: 10_000,
            retryAtMs: Date.now() + 10_000,
            errorSummary: 'Too many requests from OpenRouter',
            providerId: 'openrouter',
            modelId: 'openrouter/anthropic/claude-sonnet-4',
          },
        }}
      />,
    );

    expect(screen.getByTestId('provider-retry-notice-title')).toHaveTextContent(
      'Provider rate limit',
    );
    expect(screen.getByTestId('provider-retry-notice-error')).toHaveTextContent(
      'Too many requests from OpenRouter',
    );
    expect(
      screen.getByTestId('provider-retry-notice-status'),
    ).toHaveTextContent('Retrying in 10s (attempt 1/3)');
    expect(
      screen.getByTestId('provider-retry-notice-identity'),
    ).toHaveTextContent('Using anthropic/claude-sonnet-4 via OpenRouter');
    fireEvent.click(screen.getByTestId('provider-retry-switch-model'));
    expect(openModelSwitcher).toHaveBeenCalledOnce();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(
      screen.getByTestId('provider-retry-notice-status'),
    ).toHaveTextContent('Retrying in 6s (attempt 1/3)');
  });

  it('renders an immediate retry status without a countdown', () => {
    render(
      <ProviderRetryNoticeMessage
        text="ignored body"
        data={{
          [PROVIDER_RETRY_NOTICE_PAYLOAD_KEY]: {
            kind: 'provider_error',
            attemptNumber: 1,
            maxAttempts: 1,
            errorSummary: 'Upstream connection closed unexpectedly.',
          },
        }}
      />,
    );

    expect(screen.getByTestId('provider-retry-notice-title')).toHaveTextContent(
      'Provider error',
    );
    expect(screen.getByTestId('provider-retry-notice-error')).toHaveTextContent(
      'Upstream connection closed unexpectedly.',
    );
    expect(
      screen.getByTestId('provider-retry-notice-status'),
    ).toHaveTextContent('Retrying now (attempt 1/1)');
  });
});
