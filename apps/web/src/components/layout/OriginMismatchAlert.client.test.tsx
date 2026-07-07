import { render, screen } from '@testing-library/react';

const { queryOptionsMock, useQueryMock } = vi.hoisted(() => ({
  queryOptionsMock: vi.fn((input: unknown, options: unknown) => ({
    input,
    options,
  })),
  useQueryMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => useQueryMock(options),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    deployment: {
      assessBrowserOrigin: {
        queryOptions: queryOptionsMock,
      },
    },
  }),
}));

import { OriginMismatchAlert } from './OriginMismatchAlert';

describe('OriginMismatchAlert', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    queryOptionsMock.mockClear();
  });

  it('renders nothing while the assessment is loading', () => {
    useQueryMock.mockReturnValue({ data: undefined });

    const { container } = render(<OriginMismatchAlert />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the browser origin is trusted', () => {
    useQueryMock.mockReturnValue({
      data: {
        canonicalOrigin: window.location.origin,
        trusted: true,
      },
    });

    const { container } = render(<OriginMismatchAlert />);

    expect(container).toBeEmptyDOMElement();
  });

  it('warns with both origins and the fix when the origin is untrusted', () => {
    useQueryMock.mockReturnValue({
      data: {
        canonicalOrigin: 'https://web-production-1234.up.railway.example.app',
        trusted: false,
      },
    });

    render(<OriginMismatchAlert />);

    expect(
      screen.getByText("This address doesn't match the configured app URL"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: 'https://web-production-1234.up.railway.example.app',
      }),
    ).toHaveAttribute(
      'href',
      'https://web-production-1234.up.railway.example.app',
    );
    expect(
      screen.getByText(`ROOMOTE_APP_URL=${window.location.origin}`),
    ).toBeInTheDocument();
  });

  it('queries with the browser origin once mounted', () => {
    useQueryMock.mockReturnValue({ data: undefined });

    render(<OriginMismatchAlert />);

    expect(queryOptionsMock).toHaveBeenCalledWith(
      { browserOrigin: window.location.origin },
      expect.objectContaining({ enabled: true }),
    );
  });
});
