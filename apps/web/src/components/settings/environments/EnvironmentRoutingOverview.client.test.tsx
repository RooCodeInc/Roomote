import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { EnvironmentRoutingOverview } from './EnvironmentRoutingOverview';

const mutateAsync = vi.fn();
const environments = [{ id: 'env-1', name: 'Hospital app' }];
const routingSettings = {
  rules: [
    {
      description: 'Messages from hospital-bugs belong here.',
      target: 'env-1',
    },
  ],
};

vi.mock('@/hooks/environments', () => ({
  useEnvironments: () => ({
    isPending: false,
    data: environments,
  }),
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
  it('does not persist a deletion when edit starts', async () => {
    render(<EnvironmentRoutingOverview />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit Messages from hospital-bugs belong here.',
      }),
    );

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Rule description')).toHaveValue(
      'Messages from hospital-bugs belong here.',
    );
    expect(screen.getByRole('button', { name: 'Save Rule' })).toBeEnabled();
  });
});
