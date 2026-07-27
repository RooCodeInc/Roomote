'use client';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TERMINAL_PROVIDER_ERROR_PAYLOAD_KEY } from '@roomote/types';

import { TerminalProviderErrorMessage } from './TerminalProviderErrorMessage';

describe('TerminalProviderErrorMessage', () => {
  afterEach(cleanup);

  it('renders a terminal provider error as an alert', () => {
    render(
      <TerminalProviderErrorMessage
        data={{
          [TERMINAL_PROVIDER_ERROR_PAYLOAD_KEY]: {
            errorSummary: 'The provider returned an error: API key is invalid.',
          },
        }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Provider error');
    expect(
      screen.getByTestId('terminal-provider-error-summary'),
    ).toHaveTextContent('The provider returned an error: API key is invalid.');
  });

  it('does not render malformed terminal error data', () => {
    const { container } = render(
      <TerminalProviderErrorMessage
        data={{ [TERMINAL_PROVIDER_ERROR_PAYLOAD_KEY]: {} }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
