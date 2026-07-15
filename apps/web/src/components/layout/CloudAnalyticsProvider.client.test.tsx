import { fireEvent, render, screen } from '@testing-library/react';

import { CloudAnalyticsProvider } from './CloudAnalyticsProvider';

describe('CloudAnalyticsProvider', () => {
  beforeEach(() => {
    window.posthog = undefined;
    window.Intercom = undefined;
  });

  it('does not render cloud scripts for self-hosted deployments', () => {
    render(
      <CloudAnalyticsProvider
        cloudEnabled={false}
        intercomAppId="intercom-app"
        posthogProjectKey="posthog-project"
        userId="user-1"
      />,
    );

    expect(screen.queryByTestId('posthog-script')).not.toBeInTheDocument();
    expect(screen.queryByTestId('intercom-script')).not.toBeInTheDocument();
  });

  it('loads configured cloud integrations and identifies the signed-in user', () => {
    render(
      <CloudAnalyticsProvider
        cloudEnabled
        intercomAppId="intercom-app"
        posthogHost="https://eu.i.posthog.com"
        posthogProjectKey="posthog-project"
        userId="user-1"
      />,
    );

    const posthogScript = document.head.querySelector(
      'script[src="https://eu.i.posthog.com/static/array.js"]',
    );
    expect(posthogScript).toBeInTheDocument();
    expect(posthogScript).toHaveAttribute(
      'src',
      'https://eu.i.posthog.com/static/array.js',
    );
  });

  it('identifies a user who signs in after PostHog initializes', () => {
    const posthog = [] as unknown as Window['posthog'];
    window.posthog = posthog;

    const { rerender } = render(
      <CloudAnalyticsProvider
        cloudEnabled
        posthogProjectKey="posthog-project"
      />,
    );

    fireEvent.load(
      document.head.querySelector(
        'script[src="https://us.i.posthog.com/static/array.js"]',
      )!,
    );

    rerender(
      <CloudAnalyticsProvider
        cloudEnabled
        posthogProjectKey="posthog-project"
        userId="user-1"
      />,
    );

    expect(posthog).toContainEqual(['identify', 'user-1']);
  });
});
