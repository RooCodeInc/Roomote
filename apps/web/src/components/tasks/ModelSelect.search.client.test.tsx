import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const launchModels = vi.hoisted(() => ({
  data: undefined as
    | {
        models: Array<{ id: string; displayName: string; isDefault?: boolean }>;
        chatgptConnected?: boolean;
      }
    | undefined,
  isPending: false,
}));

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: () => launchModels,
}));

import { ModelSelect } from './ModelSelect';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  launchModels.isPending = false;
  launchModels.data = {
    chatgptConnected: true,
    models: Array.from({ length: 9 }, (_, index) => ({
      id: index === 0 ? 'openai/Canonical-ID' : `openrouter/model-${index}`,
      displayName: index === 0 ? 'Alpha Terra' : `Model ${index}`,
      isDefault: index === 0,
    })),
  };
});

describe('ModelSelect real controls', () => {
  it.each([undefined, 'Use default'])(
    'keeps eight models on Select with empty option %s',
    (emptyOptionLabel) => {
      launchModels.data!.models = launchModels.data!.models.slice(0, 8);
      render(
        <ModelSelect
          onValueChange={vi.fn()}
          emptyOptionLabel={emptyOptionLabel}
        />,
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(screen.getAllByRole('option')).toHaveLength(
        emptyOptionLabel ? 9 : 8,
      );
      expect(
        screen.queryByPlaceholderText('Search models...'),
      ).not.toBeInTheDocument();
    },
  );

  it.each([undefined, 'Use default'])(
    'makes nine models searchable with empty option %s',
    (emptyOptionLabel) => {
      render(
        <ModelSelect
          onValueChange={vi.fn()}
          emptyOptionLabel={emptyOptionLabel}
        />,
      );
      fireEvent.click(screen.getByRole('combobox'));
      expect(screen.getByPlaceholderText('Search models...')).toHaveFocus();
      expect(screen.getAllByRole('option')).toHaveLength(
        emptyOptionLabel ? 10 : 9,
      );
      expect(screen.getByText('ChatGPT (subscription)')).toBeInTheDocument();
      expect(screen.getByText('OpenRouter')).toBeInTheDocument();
      expect(
        screen.getByRole('option', { name: 'Alpha Terra (Default)' }),
      ).toBeInTheDocument();
    },
  );

  it.each(['tErRa', 'OPENAI/CANONICAL-ID'])(
    'filters by name or ID case-insensitively: %s',
    (search) => {
      render(<ModelSelect onValueChange={vi.fn()} />);
      fireEvent.click(screen.getByRole('combobox'));
      fireEvent.change(screen.getByPlaceholderText('Search models...'), {
        target: { value: search },
      });
      expect(screen.getAllByRole('option')).toHaveLength(1);
      expect(
        screen.getByRole('option', { name: 'Alpha Terra (Default)' }),
      ).toBeInTheDocument();
    },
  );

  it('keeps search available with no matches and resets it after reopening', () => {
    render(<ModelSelect onValueChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    fireEvent.change(screen.getByPlaceholderText('Search models...'), {
      target: { value: 'no-such-model' },
    });
    expect(screen.getByText('No models found.')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByPlaceholderText('Search models...')).toHaveValue(
      'no-such-model',
    );
    fireEvent.keyDown(screen.getByPlaceholderText('Search models...'), {
      key: 'Escape',
    });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByPlaceholderText('Search models...')).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(9);
  });

  it.each([
    ['Alpha Terra (Default)', 'openai/Canonical-ID'],
    ['Use default', ''],
  ])('selects %s and closes with canonical value %s', (label, value) => {
    const onValueChange = vi.fn();
    render(
      <ModelSelect
        onValueChange={onValueChange}
        emptyOptionLabel="Use default"
      />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: label }));
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(value);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('supports arrow-key selection and Enter from the search input', async () => {
    const onValueChange = vi.fn();
    render(<ModelSelect onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    const input = screen.getByPlaceholderText('Search models...');
    fireEvent.change(input, { target: { value: 'Model' } });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Model 1' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Model 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('openrouter/model-2');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('preserves the trigger label, selected default label and empty label', () => {
    const { rerender } = render(
      <ModelSelect
        value="openai/Canonical-ID"
        ariaLabel="Coding model"
        onValueChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('combobox', { name: 'Coding model' }),
    ).toHaveTextContent('Alpha Terra (Default)');
    rerender(
      <ModelSelect
        value=""
        emptyOptionLabel="Use default"
        onValueChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('Use default');
  });

  it.each(['disabled', 'pending', 'missing'])(
    'disables the trigger when %s',
    (state) => {
      launchModels.isPending = state === 'pending';
      if (state === 'missing') launchModels.data = undefined;
      render(
        <ModelSelect disabled={state === 'disabled'} onValueChange={vi.fn()} />,
      );
      expect(screen.getByRole('combobox')).toBeDisabled();
      fireEvent.click(screen.getByRole('combobox'));
      expect(
        screen.queryByPlaceholderText('Search models...'),
      ).not.toBeInTheDocument();
    },
  );
});
