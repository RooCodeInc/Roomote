import { useState } from 'react';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import {
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';

function CommandDialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open commands</button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Page commands"
        description="Find a page or action."
      >
        <CommandInput />
        <CommandList>
          <CommandItem>Settings</CommandItem>
          <CommandItem>Sessions</CommandItem>
        </CommandList>
      </CommandDialog>
    </>
  );
}

it('exposes dialog metadata only while open and preserves its accessible name and description', async () => {
  Element.prototype.scrollIntoView = vi.fn();
  render(<CommandDialogHarness />);
  expect(screen.queryByRole('heading', { name: 'Page commands' })).toBeNull();
  expect(screen.queryByText('Find a page or action.')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Open commands' }));
  const dialog = await screen.findByRole('dialog', { name: 'Page commands' });
  expect(dialog).toHaveAccessibleDescription('Find a page or action.');
  expect(
    within(dialog).getByRole('heading', { name: 'Page commands' }),
  ).toBeInTheDocument();
  const input = within(dialog).getByRole('combobox', {
    name: 'Page commands',
  });
  fireEvent.change(input, { target: { value: 'Settings' } });
  expect(
    within(dialog).getByRole('option', { name: 'Settings' }),
  ).toBeVisible();
  expect(within(dialog).queryByRole('option', { name: 'Sessions' })).toBeNull();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByRole('heading', { name: 'Page commands' })).toBeNull();
  expect(screen.queryByText('Find a page or action.')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Open commands' }));
  expect(
    await screen.findByRole('dialog', { name: 'Page commands' }),
  ).toHaveAccessibleDescription('Find a page or action.');
});
