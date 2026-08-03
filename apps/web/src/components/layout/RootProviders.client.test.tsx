import { render } from '@testing-library/react';

const themeProviderPropsSpy = vi.fn();
const cloudConsentGateSpy = vi.fn();

vi.mock('@/components/layout/providers', () => ({
  ThemeProvider: ({
    children,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) => {
    themeProviderPropsSpy(props);
    return <div data-testid="theme-provider">{children}</div>;
  },
  AuthProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PersonalThemeSync: () => null,
}));

vi.mock('@/trpc/client', () => ({
  TRPCReactProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock('@/components/system', () => ({
  Toaster: () => null,
}));

vi.mock('./UserAnalyticsContext', () => ({
  UserAnalyticsContext: () => null,
}));

vi.mock('./TelemetryProvider', () => ({
  TelemetryProvider: () => null,
}));

vi.mock('./CloudConsentGate', () => ({
  CloudConsentGate: (props: Record<string, unknown>) => {
    cloudConsentGateSpy(props);
    return null;
  },
}));

vi.mock('./StatusBanner', () => ({
  StatusBanner: () => null,
}));

import { RootProviders } from './RootProviders';

describe('RootProviders', () => {
  beforeEach(() => {
    themeProviderPropsSpy.mockClear();
    cloudConsentGateSpy.mockClear();
  });

  it('boots the theme provider from Roomote storage with a system fallback', () => {
    render(
      <RootProviders
        authStatus="signed-out"
        authUser={null}
        cloudEnabled={false}
        setupBootstrapOpen={false}
      >
        <div>child</div>
      </RootProviders>,
    );

    expect(themeProviderPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        attribute: 'class',
        defaultTheme: 'system',
        enableSystem: true,
        storageKey: 'roomote-color-theme',
      }),
    );
  });

  it('does not instantiate cloud analytics when cloud is disabled', () => {
    render(
      <RootProviders
        authStatus="signed-out"
        authUser={null}
        cloudEnabled={false}
        setupBootstrapOpen={false}
      >
        <div>child</div>
      </RootProviders>,
    );

    expect(cloudConsentGateSpy).not.toHaveBeenCalled();
  });

  it('instantiates cloud analytics only when cloud is enabled', () => {
    render(
      <RootProviders
        authStatus="signed-out"
        authUser={null}
        cloudEnabled
        intercomAppId="intercom-app"
        posthogProjectKey="posthog-project"
        setupBootstrapOpen={false}
      >
        <div>child</div>
      </RootProviders>,
    );

    expect(cloudConsentGateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cookieConsentedAt: null,
        intercomAppId: 'intercom-app',
        posthogProjectKey: 'posthog-project',
      }),
    );
  });
});
