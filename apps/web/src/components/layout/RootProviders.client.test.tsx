import { render } from '@testing-library/react';

const themeProviderPropsSpy = vi.fn();

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

vi.mock('./DebugUiAttributeController', () => ({
  DebugUiAttributeController: () => null,
}));

vi.mock('./UserAnalyticsContext', () => ({
  UserAnalyticsContext: () => null,
}));

vi.mock('./TelemetryProvider', () => ({
  TelemetryProvider: () => null,
}));

vi.mock('./CloudAnalyticsProvider', () => ({
  CloudAnalyticsProvider: () => null,
}));

import { RootProviders } from './RootProviders';

describe('RootProviders', () => {
  beforeEach(() => {
    themeProviderPropsSpy.mockClear();
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
});
