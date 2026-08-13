import { fireEvent, render, screen } from '@testing-library/react';

import { CloudAnalyticsProvider } from './CloudAnalyticsProvider';

let pathname = '/tasks';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

describe('CloudAnalyticsProvider', () => {
  beforeEach(() => {
    pathname = '/tasks';
    document.head.querySelectorAll('script').forEach((script) => {
      script.remove();
    });
    window.posthog = undefined;
    window.Intercom = undefined;
  });

  it('does not render cloud scripts for self-hosted deployments', () => {
    render(
      <CloudAnalyticsProvider
        cloudEnabled={false}
        consentGranted
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
        consentGranted
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
    expect(window.posthog?._i).toContainEqual([
      'posthog-project',
      expect.objectContaining({
        defaults: '2026-05-30',
        session_recording: { maskAllInputs: true },
      }),
    ]);
  });

  it('identifies a user who signs in after PostHog initializes', () => {
    const posthog = [] as unknown as Window['posthog'];
    window.posthog = posthog;

    const { rerender } = render(
      <CloudAnalyticsProvider
        cloudEnabled
        consentGranted
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
        consentGranted
        posthogProjectKey="posthog-project"
        userId="user-1"
      />,
    );

    expect(posthog).toContainEqual(['identify', 'user-1']);
  });

  it('hides the default Intercom launcher on signed-in pages outside the allowlist', () => {
    const intercom = vi.fn();
    window.Intercom = intercom;

    render(
      <CloudAnalyticsProvider
        cloudEnabled
        consentGranted
        intercomAppId="intercom-app"
        userId="user-1"
      />,
    );

    fireEvent.load(
      document.head.querySelector(
        'script[src="https://widget.intercom.io/widget/intercom-app"]',
      )!,
    );

    expect(intercom).toHaveBeenCalledWith('boot', {
      app_id: 'intercom-app',
      hide_default_launcher: true,
    });
  });

  it.each(['/setup', '/onboarding', '/analytics', '/automations'])(
    'keeps the default Intercom launcher visible on %s pages',
    (allowedPathname) => {
      const intercom = vi.fn();
      window.Intercom = intercom;
      pathname = allowedPathname;

      render(
        <CloudAnalyticsProvider
          cloudEnabled
          consentGranted
          intercomAppId="intercom-app"
          userId="user-1"
        />,
      );

      fireEvent.load(
        document.head.querySelector(
          'script[src="https://widget.intercom.io/widget/intercom-app"]',
        )!,
      );

      expect(intercom).toHaveBeenCalledWith('boot', {
        app_id: 'intercom-app',
        hide_default_launcher: false,
      });
    },
  );

  it('keeps the default Intercom launcher visible on settings pages', () => {
    const intercom = vi.fn();
    window.Intercom = intercom;
    pathname = '/settings';

    render(
      <CloudAnalyticsProvider
        cloudEnabled
        consentGranted
        intercomAppId="intercom-app"
        userId="user-1"
      />,
    );

    fireEvent.load(
      document.head.querySelector(
        'script[src="https://widget.intercom.io/widget/intercom-app"]',
      )!,
    );

    expect(intercom).toHaveBeenCalledWith('boot', {
      app_id: 'intercom-app',
      hide_default_launcher: false,
    });
  });

  it('shows the default Intercom launcher again after navigating into settings', () => {
    const intercom = vi.fn();
    window.Intercom = intercom;

    const { rerender } = render(
      <CloudAnalyticsProvider
        cloudEnabled
        consentGranted
        intercomAppId="intercom-app"
        userId="user-1"
      />,
    );

    fireEvent.load(
      document.head.querySelector(
        'script[src="https://widget.intercom.io/widget/intercom-app"]',
      )!,
    );

    expect(intercom).toHaveBeenCalledWith('boot', {
      app_id: 'intercom-app',
      hide_default_launcher: true,
    });

    pathname = '/settings/personal';
    rerender(
      <CloudAnalyticsProvider
        cloudEnabled
        consentGranted
        intercomAppId="intercom-app"
        userId="user-1"
      />,
    );

    expect(intercom).toHaveBeenLastCalledWith('update', {
      hide_default_launcher: false,
    });
  });

  it('waits for consent before loading cloud integrations', () => {
    const { rerender } = render(
      <CloudAnalyticsProvider
        cloudEnabled
        consentGranted={false}
        intercomAppId="intercom-app"
        posthogProjectKey="posthog-project"
      />,
    );

    expect(
      document.head.querySelector('script[src*="posthog.com"]'),
    ).not.toBeInTheDocument();
    expect(
      document.head.querySelector('script[src*="intercom.io"]'),
    ).not.toBeInTheDocument();

    rerender(
      <CloudAnalyticsProvider
        cloudEnabled
        consentGranted
        intercomAppId="intercom-app"
        posthogProjectKey="posthog-project"
      />,
    );

    expect(
      document.head.querySelector(
        'script[src="https://us.i.posthog.com/static/array.js"]',
      ),
    ).toBeInTheDocument();
    expect(
      document.head.querySelector(
        'script[src="https://widget.intercom.io/widget/intercom-app"]',
      ),
    ).toBeInTheDocument();
  });
});
