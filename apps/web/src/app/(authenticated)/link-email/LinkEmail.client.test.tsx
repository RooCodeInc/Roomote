import { fireEvent, render, screen } from '@testing-library/react';

const { previewMock, linkMock, mutateMock, searchParamsMock } = vi.hoisted(
  () => ({
    previewMock: vi.fn(),
    linkMock: vi.fn(),
    mutateMock: vi.fn(),
    searchParamsMock: vi.fn(),
  }),
);

vi.mock('next/navigation', () => ({
  useSearchParams: searchParamsMock,
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useEmailLinkPreview: previewMock,
  useLinkEmailAddress: linkMock,
}));

import { LinkEmail } from './LinkEmail';

describe('LinkEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsMock.mockReturnValue(new URLSearchParams('token=link-token'));
    previewMock.mockReturnValue({
      isPending: false,
      isError: false,
      data: { emailAddress: 'sender@example.com' },
    });
    linkMock.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: false,
      mutate: mutateMock,
    });
  });

  it('asks for confirmation and links with the token from the URL', () => {
    render(<LinkEmail />);

    expect(screen.getByText(/to your Roomote account\?/)).toBeInTheDocument();
    expect(screen.getByText('sender@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Link email address' }));

    expect(mutateMock).toHaveBeenCalledWith({ token: 'link-token' });
  });

  it('shows the invalid-link copy when the token is missing', () => {
    searchParamsMock.mockReturnValue(new URLSearchParams());

    render(<LinkEmail />);

    expect(
      screen.getByText(
        'This link is invalid or has expired. Send another email to get a fresh link.',
      ),
    ).toBeInTheDocument();
  });

  it('surfaces the preview error for an invalid token', () => {
    previewMock.mockReturnValue({
      isPending: false,
      isError: true,
      error: new Error(
        'This link is invalid or has expired. Send another email to get a fresh link.',
      ),
    });

    render(<LinkEmail />);

    expect(
      screen.getByText(
        'This link is invalid or has expired. Send another email to get a fresh link.',
      ),
    ).toBeInTheDocument();
  });

  it('reports how many earlier emails were redispatched after linking', () => {
    linkMock.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      mutate: mutateMock,
      data: { emailAddress: 'sender@example.com', redispatchedCount: 2 },
    });

    render(<LinkEmail />);

    expect(
      screen.getByText(
        'sender@example.com is linked. 2 earlier emails are being processed now — replies will arrive in your inbox.',
      ),
    ).toBeInTheDocument();
  });

  it('uses the plain success copy when nothing was redispatched', () => {
    linkMock.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      mutate: mutateMock,
      data: { emailAddress: 'sender@example.com', redispatchedCount: 0 },
    });

    render(<LinkEmail />);

    expect(
      screen.getByText(
        'Linked. Emails from this address will now reach Roomote.',
      ),
    ).toBeInTheDocument();
  });
});
