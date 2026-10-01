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

  it('has no deployment-wide switch: Auto is turned on per session', () => {
    render(<IntegrationToolAutoModeSetting />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(
      screen.getByText(/choose Auto from the tool approvals menu/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Integrations page' }),
    ).toHaveAttribute('href', '/integrations');
  });

  it('always shows the guidance and saves it without changing the stored mode', async () => {
    const { rerender } = render(<IntegrationToolAutoModeSetting />);
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
        mode: 'off',
        policy: 'Reads only.',
      }),
    );

    // A mode saved by an earlier release is kept as it was.
    state.settings = {
      mode: 'on',
      policy: 'Existing guidance',
      model: { kind: 'judgment' },
    };
    rerender(<IntegrationToolAutoModeSetting />);
    await waitFor(() =>
      expect(screen.getByLabelText('Additional instructions')).toHaveValue(
        'Existing guidance',
      ),
    );
    fireEvent.change(screen.getByLabelText('Additional instructions'), {
      target: { value: 'New guidance' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(state.setAuto).toHaveBeenLastCalledWith({
        mode: 'on',
        policy: 'New guidance',
      }),
    );
  });

  it('says when Auto has no hosted model to assess with', () => {
    render(<IntegrationToolAutoModeSetting />);
    expect(
      screen.queryByText('Auto mode isn’t available yet.'),
    ).not.toBeInTheDocument();

    state.settings = {
      mode: 'off',
      policy: 'Existing guidance',
      model: { kind: 'helper', model: 'openai/gpt-test' },
    };
    render(<IntegrationToolAutoModeSetting />);
    expect(
      screen.getByText('Auto mode isn’t available yet.'),
    ).toBeInTheDocument();
  });
});
