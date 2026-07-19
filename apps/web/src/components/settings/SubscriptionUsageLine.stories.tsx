import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { SubscriptionProviderUsage } from '@roomote/types';

import { SubscriptionUsageLine } from './SubscriptionUsageLine';

const chatGptUsage: SubscriptionProviderUsage = {
  providerId: 'chatgpt',
  planType: 'pro',
  windows: [
    {
      label: '5h limit',
      usedPercent: 42,
      resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    },
    {
      label: 'Weekly limit',
      usedPercent: 78,
      resetsAt: new Date(Date.now() + 4 * 24 * 3_600_000).toISOString(),
    },
  ],
  fetchedAt: new Date().toISOString(),
};

const copilotUsage: SubscriptionProviderUsage = {
  providerId: 'github-copilot',
  windows: [
    {
      label: 'Premium requests',
      remaining: 211,
      limit: 300,
    },
  ],
  fetchedAt: new Date().toISOString(),
};

const highUsage: SubscriptionProviderUsage = {
  providerId: 'chatgpt',
  windows: [
    {
      label: 'Weekly limit',
      usedPercent: 94,
      resetsAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    },
  ],
  fetchedAt: new Date().toISOString(),
};

function ProviderUsagePreview({
  providerLabel,
  status,
  usage,
}: {
  providerLabel: string;
  status: string;
  usage: SubscriptionProviderUsage;
}) {
  return (
    <div className="w-[420px] rounded-lg border bg-card p-4">
      <div className="grid gap-2 md:grid-cols-[minmax(140px,180px)_minmax(0,1fr)] md:items-start">
        <span className="min-w-0 truncate text-sm font-medium">
          {providerLabel}
        </span>
        <div className="min-w-0">
          <p className="min-w-0 truncate text-sm text-muted-foreground">
            {status}
          </p>
          <SubscriptionUsageLine usage={usage} className="mt-1" />
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Surfaces/Settings/SubscriptionUsageLine',
  component: SubscriptionUsageLine,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof SubscriptionUsageLine>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChatGptWindows: Story = {
  args: {
    usage: chatGptUsage,
  },
  render: () => (
    <ProviderUsagePreview
      providerLabel="ChatGPT (subscription)"
      status="Connected as user@example.com"
      usage={chatGptUsage}
    />
  ),
};

export const CopilotPremium: Story = {
  args: {
    usage: copilotUsage,
  },
  render: () => (
    <ProviderUsagePreview
      providerLabel="GitHub Copilot"
      status="Connected to a GitHub Copilot account."
      usage={copilotUsage}
    />
  ),
};

export const NearLimit: Story = {
  args: {
    usage: highUsage,
  },
  render: () => (
    <ProviderUsagePreview
      providerLabel="ChatGPT (subscription)"
      status="Connected as user@example.com"
      usage={highUsage}
    />
  ),
};
