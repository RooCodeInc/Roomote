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

it('shows name and email in a keyboard-accessible tooltip', async () => {
  render(<SessionViewerAvatars viewers={viewers.slice(0, 1)} />);
  fireEvent.focus(screen.getByLabelText('Viewer 0 (viewer0@example.com)'));
  const tooltip = await screen.findByRole('tooltip');
  expect(tooltip).toHaveTextContent('Viewer 0');
  expect(tooltip).toHaveTextContent('viewer0@example.com');
});
