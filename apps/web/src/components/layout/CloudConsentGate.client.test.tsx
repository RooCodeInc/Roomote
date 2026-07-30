import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { cloudAnalyticsProviderSpy, mutateCookieConsent } = vi.hoisted(() => ({
  cloudAnalyticsProviderSpy: vi.fn(),
  mutateCookieConsent: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: mutateCookieConsent }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    preferences: {
      acceptCookieConsent: { mutationOptions: () => ({}) },
    },
  }),
}));

vi.mock('./CloudAnalyticsProvider', () => ({
  CloudAnalyticsProvider: (props: Record<string, unknown>) => {
    cloudAnalyticsProviderSpy(props);
    return null;
  },
}));

import { CloudConsentGate } from './CloudConsentGate';

describe('CloudConsentGate', () => {
  beforeEach(() => {
    localStorage.clear();
    cloudAnalyticsProviderSpy.mockClear();
    mutateCookieConsent.mockClear();
  });

  it('shows the reference consent banner when no choice exists', async () => {
    render(
      <CloudConsentGate
        cookieConsentedAt={null}
        posthogProjectKey="posthog-project"
      />,
    );

    expect(
      await screen.findByRole('dialog', { name: 'Cookie preferences' }),
    ).toBeVisible();
    expect(screen.getByText('Like any other app, we use cookies.'));
    expect(screen.getByRole('button', { name: 'Accept all' }));
    expect(screen.getByRole('button', { name: 'Refuse non-essential' }));
  });

  it('accepts locally, records signed-in consent, and enables integrations', async () => {
    render(
      <CloudConsentGate
        cookieConsentedAt={null}
        intercomAppId="intercom-app"
        userId="user-1"
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Accept all' }));

    expect(localStorage.getItem('roomote-cookie-consent-choice')).toBe('true');
    expect(mutateCookieConsent).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(cloudAnalyticsProviderSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ consentGranted: true }),
    );
  });

  it('stores refusal only on this device and keeps integrations disabled', async () => {
    render(
      <CloudConsentGate
        cookieConsentedAt={null}
        posthogProjectKey="posthog-project"
        userId="user-1"
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'Refuse non-essential' }),
    );

    expect(localStorage.getItem('roomote-cookie-consent-choice')).toBe('false');
    expect(mutateCookieConsent).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(cloudAnalyticsProviderSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ consentGranted: false }),
    );
  });

  it('uses database acceptance across devices even after a local refusal', async () => {
    localStorage.setItem('roomote-cookie-consent-choice', 'false');

    render(
      <CloudConsentGate
        cookieConsentedAt={Date.now()}
        posthogProjectKey="posthog-project"
        userId="user-1"
      />,
    );

    await waitFor(() => {
      expect(cloudAnalyticsProviderSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ consentGranted: true }),
      );
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mutateCookieConsent).not.toHaveBeenCalled();
  });

  it('honors a local refusal when the database has no acceptance', async () => {
    localStorage.setItem('roomote-cookie-consent-choice', 'false');

    render(
      <CloudConsentGate
        cookieConsentedAt={null}
        posthogProjectKey="posthog-project"
      />,
    );

    await waitFor(() => {
      expect(cloudAnalyticsProviderSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ consentGranted: false }),
      );
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('syncs a signed-out local acceptance after sign-in', async () => {
    localStorage.setItem('roomote-cookie-consent-choice', 'true');

    render(
      <CloudConsentGate
        cookieConsentedAt={null}
        posthogProjectKey="posthog-project"
        userId="user-1"
      />,
    );

    await waitFor(() => expect(mutateCookieConsent).toHaveBeenCalledTimes(1));
    expect(cloudAnalyticsProviderSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ consentGranted: true }),
    );
  });

  it('renders nothing when no gated integration is configured', () => {
    const { container } = render(<CloudConsentGate cookieConsentedAt={null} />);

    expect(container).toBeEmptyDOMElement();
    expect(cloudAnalyticsProviderSpy).not.toHaveBeenCalled();
  });
});
