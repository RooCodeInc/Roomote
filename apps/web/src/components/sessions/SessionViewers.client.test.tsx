import { fireEvent, render, screen, within } from '@testing-library/react';
import { useSessionViewers } from '@/hooks/useSessionViewers';
import { SessionViewerAvatars, SessionViewers } from './SessionViewers';

vi.mock('@/hooks/useSessionViewers', () => ({
  useSessionViewers: vi.fn(),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ userId: '0' }),
}));

const viewers = Array.from({ length: 5 }, (_, index) => ({
  id: String(index),
  name: `Viewer ${index}`,
  email: `viewer${index}@example.com`,
  imageUrl: '',
}));

it.each([
  ['self only', [0], []],
  ['self and others', [1, 0, 2], [1, 2]],
  ['others only', [1, 2], [1, 2]],
] as const)('shows only other viewers for %s', (_, present, expected) => {
  const presence = present.map((index) => viewers[index]!);
  vi.mocked(useSessionViewers).mockReturnValue(presence);

  render(<SessionViewers sessionId="canonical-session-id" />);

  expect(useSessionViewers).toHaveBeenCalledWith('canonical-session-id');
  expect(
    screen.queryByLabelText('Viewer 0 is viewing'),
  ).not.toBeInTheDocument();
  if (expected.length === 0) {
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  } else {
    expect(
      within(screen.getByRole('group')).getAllByLabelText(/is viewing$/),
    ).toHaveLength(expected.length);
    for (const index of expected) {
      expect(
        screen.getByLabelText(`Viewer ${index} is viewing`),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', {
          name: `View sessions by Viewer ${index}`,
        }),
      ).toHaveAttribute('href', `/sessions?user=${index}`);
    }
  }
  expect(presence.map((viewer) => viewer.id)).toEqual(present.map(String));
});

it('hides an empty group and renders every viewer, including above three', () => {
  const { rerender } = render(<SessionViewerAvatars viewers={[]} />);
  expect(screen.queryByRole('group')).not.toBeInTheDocument();
  for (const count of [1, 3, 5]) {
    rerender(<SessionViewerAvatars viewers={viewers.slice(0, count)} />);
    expect(within(screen.getByRole('group')).getAllByRole('link')).toHaveLength(
      count,
    );
  }
});

it.each([
  ['Viewer 0', 'Viewer 0'],
  ['  Viewer 0  ', 'Viewer 0'],
  ['', 'viewer0@example.com'],
  ['   ', 'viewer0@example.com'],
])(
  'uses name %j in a keyboard-accessible viewing tooltip',
  async (name, identity) => {
    render(<SessionViewerAvatars viewers={[{ ...viewers[0]!, name }]} />);
    const label = `${identity} is viewing`;
    fireEvent.focus(
      screen.getByRole('link', { name: `View sessions by ${identity}` }),
    );
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe(label);
    if (name.trim())
      expect(tooltip).not.toHaveTextContent('viewer0@example.com');
  },
);
