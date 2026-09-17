import { act, fireEvent, render, screen } from '@testing-library/react';

const judgmentSettingsData = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  isPending: false,
}));
const setSelectionMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/task-models/useJudgmentModelSettings', () => ({
  useJudgmentModelSettings: () => ({
    data: judgmentSettingsData.current ?? undefined,
    isPending: judgmentSettingsData.isPending,
  }),
}));

vi.mock('@/hooks/task-models/useSetJudgmentModelSelection', () => ({
  useSetJudgmentModelSelection: () => ({
    mutateAsync: setSelectionMock,
    isPending: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from 'sonner';
import { JudgmentModelRow } from './JudgmentModelRow';

function buildSettings(overrides: Record<string, unknown> = {}) {
  return {
    typeSafe: { connected: false, source: null },
    vercelGatewayConnected: false,
    storedSelection: null,
    envSelection: null,
    effectiveSelection: 'off',
    effectiveSelectionUsable: true,
    ...overrides,
  };
}

function openSelect() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Judgment model' }));
}

describe('JudgmentModelRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    judgmentSettingsData.current = null;
    judgmentSettingsData.isPending = false;
  });

  it('explains the judgment model and disables options without a connected provider', () => {
    judgmentSettingsData.current = buildSettings();

    render(<JudgmentModelRow />);

    expect(screen.getByText('Judgment model')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Makes quick routing and triage decisions (which channel messages start work, which skill or tool fits, whether a reply is for Roomote). Anything it is unsure about falls back to the helper model.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Judgment model' }),
    ).toHaveTextContent('Off');

    openSelect();

    expect(screen.getByRole('option', { name: 'Off' })).not.toHaveAttribute(
      'data-disabled',
    );
    expect(
      screen.getByRole('option', { name: /Jev via TypeSafe/ }),
    ).toHaveTextContent('Connect TypeSafe');
    expect(
      screen.getByRole('option', { name: /Jev via TypeSafe/ }),
    ).toHaveAttribute('data-disabled');
    expect(
      screen.getByRole('option', { name: /Jev via Vercel AI Gateway/ }),
    ).toHaveTextContent('Connect Vercel AI Gateway');
    expect(
      screen.getByRole('option', { name: /Jev via Vercel AI Gateway/ }),
    ).toHaveAttribute('data-disabled');
  });

  it('saves a new selection immediately', async () => {
    judgmentSettingsData.current = buildSettings({
      typeSafe: { connected: true, source: 'settings' },
      vercelGatewayConnected: true,
      effectiveSelection: 'typesafe',
    });
    setSelectionMock.mockResolvedValue({});

    render(<JudgmentModelRow />);

    openSelect();
    expect(
      screen.getByRole('option', { name: 'Jev via Vercel AI Gateway' }),
    ).not.toHaveAttribute('data-disabled');

    await act(async () => {
      fireEvent.click(
        screen.getByRole('option', { name: 'Jev via Vercel AI Gateway' }),
      );
    });

    expect(setSelectionMock).toHaveBeenCalledWith({ selection: 'vercel' });
    expect(toast.success).toHaveBeenCalledWith(
      'Judgment model set to Jev via Vercel AI Gateway.',
    );
  });

  it('surfaces a rejected selection as an error toast', async () => {
    judgmentSettingsData.current = buildSettings({
      typeSafe: { connected: true, source: 'settings' },
      effectiveSelection: 'typesafe',
    });
    setSelectionMock.mockRejectedValue(new Error('Could not save.'));

    render(<JudgmentModelRow />);

    openSelect();
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Off' }));
    });

    expect(setSelectionMock).toHaveBeenCalledWith({ selection: 'off' });
    expect(toast.error).toHaveBeenCalledWith('Could not save.');
  });

  it('locks the selection when R_JUDGMENT_MODEL manages it', () => {
    judgmentSettingsData.current = buildSettings({
      typeSafe: { connected: true, source: 'environment' },
      envSelection: 'typesafe',
      effectiveSelection: 'typesafe',
    });

    render(<JudgmentModelRow />);

    expect(
      screen.getByLabelText('Judgment model is managed by R_JUDGMENT_MODEL'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Judgment model' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('combobox', { name: 'Judgment model' }),
    ).toHaveTextContent('Jev via TypeSafe');
  });

  it('warns when the chosen provider is no longer connected', () => {
    judgmentSettingsData.current = buildSettings({
      storedSelection: 'typesafe',
      effectiveSelection: 'typesafe',
      effectiveSelectionUsable: false,
    });

    render(<JudgmentModelRow />);

    expect(
      screen.getByText(
        'TypeSafe is not connected, so these decisions use the helper model.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a skeleton while loading and an error when loading fails', () => {
    judgmentSettingsData.isPending = true;
    const { rerender } = render(<JudgmentModelRow />);

    expect(
      screen.queryByRole('combobox', { name: 'Judgment model' }),
    ).not.toBeInTheDocument();

    judgmentSettingsData.isPending = false;
    rerender(<JudgmentModelRow />);

    expect(
      screen.getByText('Failed to load judgment model settings.'),
    ).toBeInTheDocument();
  });
});
