import { fireEvent, render, screen } from '@testing-library/react';

import { SlackChannelSelect } from './SlackChannelSelect';

const options = [
  { id: 'C123ABC456', name: 'product-debug', label: '#product-debug' },
  { id: 'C987DEF654', name: 'engineering', label: '#engineering' },
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('SlackChannelSelect', () => {
  it.each(['C123ABC456', '#product-debug', 'product-debug'])(
    'marks the displayed channel when its value is %s',
    (value) => {
      render(
        <SlackChannelSelect
          value={value}
          options={options}
          onChange={vi.fn()}
        />,
      );

      expect(screen.getByRole('combobox')).toHaveTextContent('#product-debug');
      fireEvent.click(screen.getByRole('combobox'));

      // The marker's visibility is the regression: saved settings hydrate a name,
      // while a fresh selection supplies an ID. Both must mark the same channel.
      expect(
        screen
          .getByRole('option', { name: '#product-debug' })
          .querySelector('svg'),
      ).toHaveClass('opacity-100');
      expect(
        screen
          .getByRole('option', { name: '#engineering' })
          .querySelector('svg'),
      ).toHaveClass('opacity-0');
    },
  );

  it.each([null, 'CUNKNOWN'])(
    'does not mark a channel for an unmatched value %s',
    (value) => {
      render(
        <SlackChannelSelect
          value={value}
          options={options}
          onChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole('combobox'));

      for (const option of screen.getAllByRole('option')) {
        expect(option.querySelector('svg')).toHaveClass('opacity-0');
      }
    },
  );

  it('emits the canonical ID and closes when changing a hydrated selection', () => {
    const onChange = vi.fn();
    render(
      <SlackChannelSelect
        value="#product-debug"
        options={options}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: '#engineering' }));

    expect(onChange).toHaveBeenCalledWith('C987DEF654');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
