import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

import { EnvironmentRoutingOverview } from './EnvironmentRoutingOverview';

const mutateAsync = vi.fn();
const routingSettings = {
  guidance: 'Use Hospital app for messages from hospital-bugs.',
};

vi.mock('@/hooks/environments', () => ({
  useWorkspaceRoutingSettings: () => ({
    isPending: false,
    data: routingSettings,
  }),
  useUpdateWorkspaceRoutingSettings: () => ({
    isPending: false,
    mutateAsync,
  }),
}));

describe('EnvironmentRoutingOverview', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
  });

  it('loads and saves free-text environment and model guidance', async () => {
    mutateAsync.mockResolvedValue({
      guidance: 'Use Hospital app for frontend work. Prefer GPT-5.6.',
    });
    render(<EnvironmentRoutingOverview />);

    const textarea = screen.getByLabelText('Routing guidance');
    expect(textarea).toHaveValue(
      'Use Hospital app for messages from hospital-bugs.',
    );
    fireEvent.change(textarea, {
      target: { value: 'Use Hospital app for frontend work. Prefer GPT-5.6.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        guidance: 'Use Hospital app for frontend work. Prefer GPT-5.6.',
      });
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });
  });

  it('clears saved guidance', async () => {
    mutateAsync.mockResolvedValue({ guidance: '' });
    render(<EnvironmentRoutingOverview />);

    fireEvent.change(screen.getByLabelText('Routing guidance'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ guidance: '' });
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });
  });
});
