import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { ReasoningEffort } from '@roomote/types';

const mobileState = vi.hoisted(() => ({ current: false }));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mobileState.current,
}));

import {
  ModelReasoningPicker,
  type ModelReasoningPickerModel,
} from './ModelReasoningPicker';

const models: ModelReasoningPickerModel[] = [
  {
    id: 'provider/alpha',
    displayName: 'Alpha',
    metadata: {
      contextWindow: null,
      inputTypes: null,
      inputPricePerToken: null,
      outputPricePerToken: null,
      lastRefreshedAt: null,
      supportedReasoningEfforts: ['low', 'high'],
    },
  },
  {
    id: 'provider/beta',
    displayName: 'Beta',
    metadata: {
      contextWindow: null,
      inputTypes: null,
      inputPricePerToken: null,
      outputPricePerToken: null,
      lastRefreshedAt: null,
      supportedReasoningEfforts: ['medium'],
    },
  },
  {
    id: 'provider/plain',
    displayName: 'Plain',
    metadata: {
      contextWindow: null,
      inputTypes: null,
      inputPricePerToken: null,
      outputPricePerToken: null,
      lastRefreshedAt: null,
      supportsReasoning: false,
    },
  },
];

function Harness({
  initialEffort = 'low' as ReasoningEffort | null,
}: {
  initialEffort?: ReasoningEffort | null;
}) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState('provider/alpha');
  const [effort, setEffort] = useState<ReasoningEffort | null>(initialEffort);

  return (
    <>
      <output data-testid="selection">{`${model}:${effort ?? 'default'}`}</output>
      <ModelReasoningPicker
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button
            type="button"
            aria-label="Choose model"
            onClick={() => setOpen(true)}
          >
            {models.find(({ id }) => id === model)?.displayName ?? 'Model'}
          </button>
        }
        models={models}
        model={model}
        onModelChange={setModel}
        reasoningEffort={effort}
        defaultReasoningEffort="medium"
        onReasoningEffortChange={setEffort}
      />
    </>
  );
}

describe('ModelReasoningPicker', () => {
  beforeEach(() => {
    mobileState.current = false;
  });

  it('applies model and wheel changes immediately while staying open', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));

    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    expect(screen.getByRole('listbox', { name: 'Models' })).toBeVisible();
    expect(screen.getByTestId('selection')).toHaveTextContent(
      'provider/beta:medium',
    );
    expect(
      screen.getByRole('slider', { name: 'Reasoning level' }),
    ).toHaveAttribute('data-disabled');

    fireEvent.click(screen.getByRole('option', { name: 'Alpha' }));
    fireEvent.wheel(screen.getByRole('slider', { name: 'Reasoning level' }), {
      deltaY: -40,
    });
    expect(screen.getByTestId('selection')).toHaveTextContent(
      'provider/alpha:high',
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      const trigger = document.querySelector('[data-slot="popover-trigger"]');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
    expect(screen.getByTestId('selection')).toHaveTextContent(
      'provider/alpha:high',
    );
  });

  it('supports list keyboard navigation and no-reasoning models', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));

    const alpha = screen.getByRole('option', { name: 'Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'End' });
    expect(screen.getByRole('option', { name: 'Plain' })).toHaveFocus();
    fireEvent.click(screen.getByRole('option', { name: 'Plain' }));

    expect(screen.getByText('No reasoning')).toBeVisible();
    expect(
      screen.getByRole('slider', { name: 'Reasoning level' }),
    ).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('selection')).toHaveTextContent(
      'provider/plain:default',
    );
  });

  it('persists the effective supported effort when switching from a no-override state', () => {
    render(<Harness initialEffort={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));

    // No-override (null) plus a restricted model: the picker emits the
    // effective allowed effort instead of leaving the launch unspecified.
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    expect(screen.getByTestId('selection')).toHaveTextContent(
      'provider/beta:medium',
    );

    // A model without reasoning support keeps the no-override state.
    fireEvent.click(screen.getByRole('option', { name: 'Plain' }));
    expect(screen.getByTestId('selection')).toHaveTextContent(
      'provider/plain:default',
    );
  });

  it('scrolls the model list to typed prefixes and closes on Enter', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));

    fireEvent.keyDown(document.body, { key: 'b' });
    expect(screen.getByRole('option', { name: 'Beta' })).toHaveFocus();

    // Backspace empties the buffer; the next keystroke starts a fresh prefix.
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveFocus();

    // Enter closes the picker without changing the selection.
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => {
      const trigger = document.querySelector('[data-slot="popover-trigger"]');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
    expect(screen.getByTestId('selection')).toHaveTextContent(
      'provider/alpha:low',
    );
  });

  it('keeps Enter from activating a typeahead-focused option', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));

    fireEvent.keyDown(document.body, { key: 'b' });
    expect(screen.getByRole('option', { name: 'Beta' })).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Enter' });

    // The focused option was not selected; the current selection stands.
    expect(screen.getByTestId('selection')).toHaveTextContent(
      'provider/alpha:low',
    );
  });

  it('uses a dismissible mobile drawer without a close action', async () => {
    mobileState.current = true;
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));

    expect(screen.getByText('Choose model and reasoning')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /close/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    expect(screen.getByRole('listbox', { name: 'Models' })).toBeVisible();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      const trigger = document.querySelector('[data-slot="drawer-trigger"]');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
    expect(screen.getByTestId('selection')).toHaveTextContent(
      'provider/beta:medium',
    );
  });
});
