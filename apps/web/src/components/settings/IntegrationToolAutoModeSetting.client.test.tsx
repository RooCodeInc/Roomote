import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  settings: {
    mode: 'off' as 'off' | 'on',
    policy: '',
    model: { kind: 'judgment' } as
      | { kind: 'judgment' }
      | { kind: 'helper'; model: string }
      | null,
  },
  setAuto: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state.settings }),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useMutation: (options: { mutationFn: (input: unknown) => unknown }) => ({
    isPending: false,
    mutate: (input: unknown) => {
      state.setAuto(input);
      return options.mutationFn(input);
    },
  }),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    integrationToolPolicies: {
      getAuto: { queryOptions: () => ({}), queryKey: () => ['auto'] },
      setAuto: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: async (input: unknown) => input,
        }),
      },
    },
  }),
}));

import { IntegrationToolAutoModeSetting } from './IntegrationToolAutoModeSetting';

describe('IntegrationToolAutoModeSetting', () => {
  beforeEach(() => {
    state.settings = { mode: 'off', policy: '', model: { kind: 'judgment' } };
    state.setAuto.mockClear();
  });

  it('shows the approval switch and a link to integration tool controls', () => {
    render(<IntegrationToolAutoModeSetting />);
    expect(
      screen.getByRole('switch', { name: 'Enable auto-approval' }),
    ).not.toBeChecked();
    expect(
      screen.getByText(
        'Let Roomote decide when something is worth interrupting for approval.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Integrations page' }),
    ).toHaveAttribute('href', '/integrations');
    expect(
      screen.queryByLabelText('Additional instructions'),
    ).not.toBeInTheDocument();
  });

  it('shows guidance when enabled and saves changes using the current mode', async () => {
    state.settings = { mode: 'on', policy: '', model: { kind: 'judgment' } };
    render(<IntegrationToolAutoModeSetting />);
    expect(
      screen.getByRole('switch', { name: 'Enable auto-approval' }),
    ).toBeChecked();
    expect(
      screen.getByLabelText('Additional instructions'),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(
        'Include any specific guidance for how to decide auto-approval here',
      ),
    ).toBeInTheDocument();
    const guidance = screen.getByLabelText('Additional instructions');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(guidance, { target: { value: 'Reads only.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(state.setAuto).toHaveBeenLastCalledWith({
        mode: 'on',
        policy: 'Reads only.',
      }),
    );
    fireEvent.click(
      screen.getByRole('switch', { name: 'Enable auto-approval' }),
    );
    expect(state.setAuto).toHaveBeenLastCalledWith({
      mode: 'off',
      policy: 'Reads only.',
    });
  });

  it('enables auto-approval through the same policy mutation', () => {
    render(<IntegrationToolAutoModeSetting />);
    fireEvent.click(
      screen.getByRole('switch', { name: 'Enable auto-approval' }),
    );
    expect(state.setAuto).toHaveBeenCalledWith({ mode: 'on', policy: '' });
  });

  it('keeps the switch disabled with no availability message when off and no hosted model exists', () => {
    state.settings = {
      mode: 'off',
      policy: '',
      model: { kind: 'helper', model: 'openai/gpt-5.6-mini' },
    };
    render(<IntegrationToolAutoModeSetting />);
    expect(
      screen.getByRole('switch', { name: 'Enable auto-approval' }),
    ).toBeDisabled();
    expect(
      screen.queryByText('Auto mode isn’t available yet.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Additional instructions'),
    ).not.toBeInTheDocument();
  });

  it('keeps guidance visible and allows disabling if the hosted model becomes unavailable', () => {
    state.settings = {
      mode: 'on',
      policy: 'Existing guidance',
      model: { kind: 'judgment' },
    };
    const { rerender } = render(<IntegrationToolAutoModeSetting />);
    state.settings = { ...state.settings, model: null };
    rerender(<IntegrationToolAutoModeSetting />);
    const toggle = screen.getByRole('switch', { name: 'Enable auto-approval' });
    expect(toggle).toBeEnabled();
    expect(toggle).toBeChecked();
    expect(
      screen.getByText('Auto mode isn’t available yet.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Additional instructions')).toHaveValue(
      'Existing guidance',
    );
    fireEvent.click(toggle);
    expect(state.setAuto).toHaveBeenCalledWith({
      mode: 'off',
      policy: 'Existing guidance',
    });
  });
});
