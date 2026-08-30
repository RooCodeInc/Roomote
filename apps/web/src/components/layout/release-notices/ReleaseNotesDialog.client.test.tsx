// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockHistoryQueryOptions, mockUseQuery } = vi.hoisted(() => ({
  mockHistoryQueryOptions: vi.fn((input: { version: string }) => ({
    queryKey: ['releases.history', input.version],
  })),
  mockUseQuery: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    releases: {
      history: {
        queryOptions: mockHistoryQueryOptions,
      },
    },
  }),
}));

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/system', () => ({
  Astroid: () => <svg />,
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ChevronDown: () => <svg />,
  Collapsible: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  CollapsibleContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <footer>{children}</footer>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
  Spinner: () => <span>Loading</span>,
  SquareArrowOutUpRight: () => <svg />,
}));

import { ReleaseNotesDialog } from './ReleaseNotesDialog';

describe('ReleaseNotesDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the current release first and includes previous releases', () => {
    mockUseQuery.mockReturnValue({
      data: [
        {
          version: '0.16.0',
          summary: 'Current release.',
          highlights: [],
          detailsMarkdown: '',
          htmlUrl: 'https://example.com/v0.16.0',
        },
        {
          version: '0.15.0',
          summary: 'Previous release.',
          highlights: [],
          detailsMarkdown: '',
          htmlUrl: 'https://example.com/v0.15.0',
        },
        {
          version: '0.14.0',
          summary: 'Older release.',
          highlights: [],
          detailsMarkdown: '',
          htmlUrl: 'https://example.com/v0.14.0',
        },
      ],
      isLoading: false,
    });

    render(
      <ReleaseNotesDialog
        open
        onOpenChange={vi.fn()}
        mode="whats-new"
        version="0.16.0"
      />,
    );

    expect(mockHistoryQueryOptions).toHaveBeenCalledWith(
      { version: '0.16.0' },
      expect.objectContaining({ enabled: true }),
    );
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Roomote v0.16.0', 'Roomote v0.15.0', 'Roomote v0.14.0']);
    expect(screen.getByText('Latest')).toBeTruthy();
    expect(screen.getByLabelText('Release history')).toBeTruthy();
  });
});
