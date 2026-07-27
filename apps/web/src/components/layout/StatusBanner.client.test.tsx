import { fireEvent, render, screen } from '@testing-library/react';

const { useQueryMock, useTRPCMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  useTRPCMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({ useQuery: useQueryMock }));
vi.mock('@/trpc/client', () => ({ useTRPC: useTRPCMock }));

vi.mock('@/components/system', () => ({
  ArrowRight: () => <svg />,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  CircleAlert: () => <svg />,
  Info: () => <svg />,
  OctagonAlert: () => <svg />,
  TriangleAlert: () => <svg />,
  X: () => <svg />,
}));

import { StatusBanner } from './StatusBanner';

const incident = {
  id: 'incident-1',
  name: 'Task launches are delayed',
  status: 'investigating',
  impact: 'major' as const,
  created_at: '2026-01-01T00:00:00Z',
  shortlink: 'https://stspg.io/incident-1',
  url: null,
};

describe('StatusBanner', () => {
  beforeEach(() => {
    localStorage.clear();
    useTRPCMock.mockReturnValue({
      statuspage: {
        incident: { queryOptions: () => ({ queryKey: ['status'] }) },
      },
    });
    useQueryMock.mockReturnValue({ data: incident });
  });

  it('shows the incident and updates the document visibility attribute', () => {
    render(<StatusBanner />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Task launches are delayed',
    );
    expect(screen.getByRole('link', { name: /details/i })).toHaveAttribute(
      'href',
      'https://stspg.io/incident-1',
    );
    expect(document.documentElement).toHaveAttribute(
      'data-status-banner-visible',
      'true',
    );
    expect(screen.getByText('major incident')).toBeInTheDocument();
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ refetchInterval: 5 * 60 * 1000 }),
    );
  });

  it('dismisses only the current incident', () => {
    render(<StatusBanner />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss notification' }),
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(localStorage.getItem('roomote-statuspage-dismissed-incidents')).toBe(
      'incident-1',
    );
  });
});
