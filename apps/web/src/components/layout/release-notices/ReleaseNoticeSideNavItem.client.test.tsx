// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockUseQuery,
  mockStatusData,
  mockWriteWhatsNewSeenVersion,
  mockReadWhatsNewSeenVersion,
} = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockStatusData: vi.fn(),
  mockWriteWhatsNewSeenVersion: vi.fn(),
  mockReadWhatsNewSeenVersion: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    releases: {
      status: {
        queryOptions: () => ({ queryKey: ['releases.status'] }),
      },
      notes: {
        queryOptions: () => ({ queryKey: ['releases.notes'] }),
      },
    },
  }),
}));

vi.mock('./whats-new-storage', () => ({
  readWhatsNewSeenVersion: () => mockReadWhatsNewSeenVersion(),
  writeWhatsNewSeenVersion: (...args: unknown[]) =>
    mockWriteWhatsNewSeenVersion(...args),
}));

vi.mock('./ReleaseNotesDialog', () => ({
  ReleaseNotesDialog: ({
    open,
    mode,
    version,
  }: {
    open: boolean;
    mode: string;
    version: string;
  }) =>
    open ? (
      <div data-testid="release-notes-dialog">
        {mode}:{version}
      </div>
    ) : null,
}));

vi.mock('../side-nav/SideNavItem', () => ({
  SideNavItem: ({
    label,
    onClick,
  }: {
    label?: string;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  ),
}));

vi.mock('@/components/system', () => ({
  Astroid: () => <svg data-testid="astroid" />,
  Sparkles: () => <svg data-testid="sparkles" />,
}));

import { ReleaseNoticeSideNavItem } from './ReleaseNoticeSideNavItem';

describe('ReleaseNoticeSideNavItem', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    mockUseQuery.mockImplementation((options: { queryKey?: string[] }) => {
      if (options?.queryKey?.[0] === 'releases.notes') {
        return { data: null, isLoading: false };
      }
      return {
        data: mockStatusData(),
        isLoading: false,
      };
    });
  });

  it('sets a silent baseline on first visit and renders nothing', async () => {
    mockReadWhatsNewSeenVersion.mockReturnValue(null);
    mockStatusData.mockReturnValue({
      runningVersion: '0.15.0',
      latestKnownVersion: null,
      updateAvailable: false,
    });

    const { container } = render(<ReleaseNoticeSideNavItem />);

    await waitFor(() => {
      expect(mockWriteWhatsNewSeenVersion).toHaveBeenCalledWith('0.15.0');
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows whats-new before update-available', async () => {
    mockReadWhatsNewSeenVersion.mockReturnValue('0.14.0');
    mockStatusData.mockReturnValue({
      runningVersion: '0.15.0',
      latestKnownVersion: '0.16.0',
      updateAvailable: true,
    });

    render(<ReleaseNoticeSideNavItem />);

    expect(
      await screen.findByRole('button', { name: "What's new" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "What's new" }));
    expect(mockWriteWhatsNewSeenVersion).toHaveBeenCalledWith('0.15.0');
    expect(screen.getByTestId('release-notes-dialog').textContent).toBe(
      'whats-new:0.15.0',
    );
  });

  it('shows update-available after whats-new is seen', async () => {
    mockReadWhatsNewSeenVersion.mockReturnValue('0.15.0');
    mockStatusData.mockReturnValue({
      runningVersion: '0.15.0',
      latestKnownVersion: '0.16.0',
      updateAvailable: true,
    });

    render(<ReleaseNoticeSideNavItem />);

    expect(
      await screen.findByRole('button', { name: 'Update available' }),
    ).toBeTruthy();
  });
});
