import { fireEvent, render, screen, within } from '@testing-library/react';
import { SessionViewerAvatars } from './SessionViewers';

const viewers = Array.from({ length: 5 }, (_, index) => ({
  id: String(index),
  name: `Viewer ${index}`,
  email: `viewer${index}@example.com`,
  imageUrl: '',
}));

it('hides an empty group and renders every viewer, including above three', () => {
  const { rerender } = render(<SessionViewerAvatars viewers={[]} />);
  expect(screen.queryByRole('group')).not.toBeInTheDocument();
  for (const count of [1, 3, 5]) {
    rerender(<SessionViewerAvatars viewers={viewers.slice(0, count)} />);
    expect(
      within(screen.getByRole('group')).getAllByLabelText(/Viewer \d/),
    ).toHaveLength(count);
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
    fireEvent.focus(screen.getByLabelText(label));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe(label);
    if (name.trim())
      expect(tooltip).not.toHaveTextContent('viewer0@example.com');
  },
);
