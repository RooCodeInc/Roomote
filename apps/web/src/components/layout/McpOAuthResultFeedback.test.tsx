import { render } from '@testing-library/react';

const { navigationState, toastErrorMock, toastSuccessMock } = vi.hoisted(
  () => ({
    navigationState: {
      pathname: '/settings/integrations',
      searchParams: '',
    },
    toastErrorMock: vi.fn(),
    toastSuccessMock: vi.fn(),
  }),
);

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
  useSearchParams: () => new URLSearchParams(navigationState.searchParams),
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

vi.mock('@roomote/types', () => ({
  MCP_INTEGRATIONS: [{ id: 'linear', name: 'Linear' }],
}));

import { McpOAuthResultFeedback } from './McpOAuthResultFeedback';

describe('McpOAuthResultFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationState.pathname = '/settings/integrations';
    navigationState.searchParams = '';
    window.history.replaceState(null, '', navigationState.pathname);
  });

  it('explains failures and removes only the transient OAuth parameters', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    navigationState.searchParams =
      'service=linear&mcp=error&reason=linear_metadata_failed&tab=accounts';
    window.history.replaceState(
      null,
      '',
      `${navigationState.pathname}?${navigationState.searchParams}`,
    );

    render(<McpOAuthResultFeedback />);

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Roomote connected to Linear but could not verify the workspace. Try again.',
    );
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '/settings/integrations?service=linear&tab=accounts',
    );
  });

  it('confirms success on any authenticated return page', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    navigationState.pathname = '/';
    navigationState.searchParams = 'service=linear&mcp=connected';
    window.history.replaceState(
      null,
      '',
      `${navigationState.pathname}?${navigationState.searchParams}`,
    );

    render(<McpOAuthResultFeedback />);

    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Linear connected successfully.',
    );
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/?service=linear');
  });
});
