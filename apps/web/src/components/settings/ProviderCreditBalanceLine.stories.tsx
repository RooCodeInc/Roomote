import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import type { ProviderCreditBalance } from '@roomote/types';

import { ProviderCreditBalanceLine } from './ProviderCreditBalanceLine';

const mockBalance: ProviderCreditBalance = {
  providerId: 'openrouter',
  remaining: 12.5,
  limit: 50,
  currency: 'USD',
  fetchedAt: '2026-07-19T00:00:00.000Z',
};

function ProviderRowShell({ balance }: { balance?: ProviderCreditBalance }) {
  return (
    <div className="max-w-md rounded-lg border border-border bg-card p-4">
      <p className="mb-2 text-sm font-medium">OpenRouter</p>
      <div className="rounded-md border border-input bg-muted/30 px-3 py-2 font-mono text-sm text-muted-foreground">
        ••••••••••••••••••••••••••••
      </div>
      <ProviderCreditBalanceLine balance={balance} className="mt-1" />
    </div>
  );
}

const meta = {
  title: 'Surfaces/Settings/ProviderCreditBalanceLine',
  component: ProviderCreditBalanceLine,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ProviderCreditBalanceLine>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithRemainingAndLimit: Story = {
  args: {
    balance: mockBalance,
  },
  render: () => <ProviderRowShell balance={mockBalance} />,
};

export const RemainingOnly: Story = {
  args: {
    balance: {
      ...mockBalance,
      limit: undefined,
      remaining: 3,
    },
  },
  render: () => (
    <ProviderRowShell
      balance={{
        ...mockBalance,
        limit: undefined,
        remaining: 3,
      }}
    />
  ),
};

export const Empty: Story = {
  args: {
    balance: undefined,
  },
  render: () => <ProviderRowShell balance={undefined} />,
};
