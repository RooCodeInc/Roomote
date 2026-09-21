import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import type { ReasoningEffort } from '@roomote/types';

const mobileState = vi.hoisted(() => ({ current: false }));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mobileState.current,
}));

import {
  ModelReasoningPicker,
  ModelReasoningPickerTrigger,
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
  initialModel = 'provider/alpha',
  initialEffort = 'low' as ReasoningEffort | null,
  defaultModelId,
  availableModels = models,
}: {
  initialModel?: string;
  initialEffort?: ReasoningEffort | null;
  defaultModelId?: string | null;
  availableModels?: ModelReasoningPickerModel[];
}) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(initialModel);
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
            {availableModels.find(({ id }) => id === model)?.displayName ??
              'Model'}
          </button>
        }
        models={availableModels}
        model={model}
        defaultModelId={defaultModelId}
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

  afterEach(async () => {
    // Radix focus-scope schedules focus-out dispatch timers during popover
    // and drawer interactions. Flush them inside this test's environment;
    // firing after jsdom teardown throws a cross-realm dispatchEvent error
    // that Vitest reports as an unhandled error and fails the whole run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
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
    const slider = screen.getByRole('slider', { name: 'Reasoning level' });
    const pageWheelListener = vi.fn();
    document.body.addEventListener('wheel', pageWheelListener);
    const wheelToHigh = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -40,
    });
    fireEvent(slider, wheelToHigh);
    const wheelAtHigh = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -40,
    });
    fireEvent(slider, wheelAtHigh);
    document.body.removeEventListener('wheel', pageWheelListener);

    expect(wheelToHigh.defaultPrevented).toBe(true);
    expect(wheelAtHigh.defaultPrevented).toBe(true);
    expect(pageWheelListener).not.toHaveBeenCalled();
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

  it('briefly flashes the trigger when its selection changes', async () => {
    const { rerender } = render(
      <ModelReasoningPickerTrigger
        label="Alpha"
        reasoningEffort="low"
        ariaLabel="Model selection"
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Model selection' });
    expect(trigger).toHaveAttribute('data-selection-flash', 'false');

    rerender(
      <ModelReasoningPickerTrigger
        label="Beta"
        reasoningEffort="high"
        ariaLabel="Model selection"
      />,
    );
    await waitFor(() =>
      expect(trigger).toHaveAttribute('data-selection-flash', 'true'),
    );
    await waitFor(
      () => expect(trigger).toHaveAttribute('data-selection-flash', 'false'),
      { timeout: 500 },
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

  it('groups model options under non-selectable provider labels', () => {
    render(
      <Harness
        availableModels={[
          ...models,
          { id: 'anthropic/claude', displayName: 'Claude' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));

    expect(
      screen.getByRole('group', { name: 'Anthropic models' }),
    ).toBeVisible();
    expect(
      screen.getByRole('group', { name: 'Provider models' }),
    ).toBeVisible();
    expect(screen.getAllByRole('option')).toHaveLength(4);
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

  it('selects the real default model without adding a duplicate option', () => {
    render(<Harness initialModel="" defaultModelId="provider/beta" />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));

    const betaOptions = screen.getAllByRole('option', { name: 'Beta' });
    expect(betaOptions).toHaveLength(1);
    expect(betaOptions[0]).toHaveAttribute('aria-selected', 'true');
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
