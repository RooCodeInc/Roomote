import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const launchModelsData = vi.hoisted(() => ({
  current: null as {
    defaultModelId: string;
    chatgptConnected: boolean;
    models: Array<{
      id: string;
      displayName: string;
      isDefault?: boolean;
    }>;
  } | null,
}));

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: () => ({
    data: launchModelsData.current,
    isPending: launchModelsData.current === null,
  }),
}));

vi.mock('@/components/system', async () => {
  const actual = await vi.importActual<typeof import('@/components/system')>(
    '@/components/system',
  );

  return {
    ...actual,
    Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectTrigger: ({ children, ...props }: { children: ReactNode }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => (
      <span>{placeholder}</span>
    ),
    SelectContent: ({ children }: { children: ReactNode }) => (
      <div data-testid="select-content">{children}</div>
    ),
    SelectGroup: ({ children }: { children: ReactNode }) => (
      <div data-testid="select-group">{children}</div>
    ),
    SelectLabel: ({ children }: { children: ReactNode }) => (
      <div data-testid="select-label">{children}</div>
    ),
    SelectItem: ({
      children,
      value,
    }: {
      children: ReactNode;
      value: string;
    }) => (
      <div data-testid="select-item" data-value={value}>
        {children}
      </div>
    ),
  };
});

import { ModelSelect } from './ModelSelect';

describe('ModelSelect', () => {
  it('shows provider headers when multiple providers are represented', () => {
    launchModelsData.current = {
      defaultModelId: 'openrouter/x-ai/grok-4.5',
      chatgptConnected: true,
      models: [
        {
          id: 'openrouter/x-ai/grok-4.5',
          displayName: 'Grok 4.5',
          isDefault: true,
        },
        {
          id: 'openai/gpt-5.6-terra',
          displayName: 'GPT 5.6 Terra',
        },
      ],
    };

    render(
      <ModelSelect value="openrouter/x-ai/grok-4.5" onValueChange={vi.fn()} />,
    );

    expect(
      screen.getAllByTestId('select-label').map((node) => node.textContent),
    ).toEqual(['OpenRouter', 'ChatGPT (subscription)']);
    expect(screen.getByText('Grok 4.5 (Default)')).toBeTruthy();
    expect(screen.getByText('GPT 5.6 Terra')).toBeTruthy();
  });

  it('omits provider headers when only one provider group is present', () => {
    launchModelsData.current = {
      defaultModelId: 'openrouter/x-ai/grok-4.5',
      chatgptConnected: false,
      models: [
        {
          id: 'openrouter/x-ai/grok-4.5',
          displayName: 'Grok 4.5',
          isDefault: true,
        },
        {
          id: 'openrouter/anthropic/claude-sonnet-5',
          displayName: 'Claude Sonnet 5',
        },
      ],
    };

    render(
      <ModelSelect value="openrouter/x-ai/grok-4.5" onValueChange={vi.fn()} />,
    );

    expect(screen.queryByTestId('select-label')).toBeNull();
    expect(screen.getByText('Grok 4.5 (Default)')).toBeTruthy();
    expect(screen.getByText('Claude Sonnet 5')).toBeTruthy();
  });
});
