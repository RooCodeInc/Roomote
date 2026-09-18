import { render, screen } from '@testing-library/react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const launchModelsData = vi.hoisted(() => ({
  current: undefined as
    | {
        defaultFastModelId: string;
        defaultFastReasoningEffort: 'low' | 'medium' | 'high';
        models: Array<{ id: string; displayName: string }>;
      }
    | undefined,
}));

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: () => ({ data: launchModelsData.current }),
}));

vi.mock('@/components/system', () => ({
  BasicTooltip: ({ children }: { children: ReactNode }) => children,
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props} />
  ),
  ChevronDown: () => <span aria-hidden="true" />,
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/components/tasks/ModelSelect', () => ({
  ModelSelect: ({ emptyOptionLabel }: { emptyOptionLabel?: string }) => (
    <div data-testid="model-default-option">{emptyOptionLabel}</div>
  ),
}));

vi.mock('@/components/tasks/ReasoningEffortSelect', () => ({
  ReasoningEffortSelect: ({
    defaultEffort,
  }: {
    defaultEffort?: string | null;
  }) => (
    <div data-testid="reasoning-default">{defaultEffort ?? 'Reasoning'}</div>
  ),
}));

import { SessionModelSwitcher } from './SessionModelSwitcher';

const defaultProps = {
  model: '',
  onModelChange: vi.fn(),
  reasoningEffort: null,
  onReasoningEffortChange: vi.fn(),
};

describe('SessionModelSwitcher', () => {
  beforeEach(() => {
    launchModelsData.current = undefined;
  });

  it('shows the resolved Fast defaults from the launch model query', () => {
    launchModelsData.current = {
      defaultFastModelId: 'anthropic/claude-sonnet-5',
      defaultFastReasoningEffort: 'high',
      models: [
        {
          id: 'anthropic/claude-sonnet-5',
          displayName: 'Claude Sonnet 5',
        },
      ],
    };

    render(<SessionModelSwitcher {...defaultProps} />);

    expect(
      screen.getByRole('button', { name: 'Model for this session' }),
    ).toHaveTextContent('Claude Sonnet 5High');
    expect(screen.getByTestId('model-default-option')).toHaveTextContent(
      'Default (Claude Sonnet 5)',
    );
    expect(screen.getByTestId('reasoning-default')).toHaveTextContent('high');
  });

  it('does not invent a model or reasoning level while defaults are unresolved', () => {
    render(<SessionModelSwitcher {...defaultProps} />);

    expect(
      screen.getByRole('button', { name: 'Model for this session' }),
    ).toHaveTextContent(/^Model$/);
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-default-option')).toHaveTextContent(
      'Deployment default',
    );
    expect(screen.getByTestId('reasoning-default')).toHaveTextContent(
      'Reasoning',
    );
  });

  it('prefers explicit selections and caller defaults over query defaults', () => {
    launchModelsData.current = {
      defaultFastModelId: 'anthropic/claude-sonnet-5',
      defaultFastReasoningEffort: 'high',
      models: [
        {
          id: 'anthropic/claude-sonnet-5',
          displayName: 'Claude Sonnet 5',
        },
        { id: 'openai/gpt-5.6', displayName: 'GPT 5.6' },
      ],
    };

    render(
      <SessionModelSwitcher
        {...defaultProps}
        model="openai/gpt-5.6"
        reasoningEffort="low"
        defaultModelId="openai/gpt-5.6"
        defaultReasoningEffort="medium"
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Model for this session' }),
    ).toHaveTextContent('GPT 5.6Low');
    expect(screen.getByTestId('model-default-option')).toHaveTextContent(
      'Default (GPT 5.6)',
    );
    expect(screen.getByTestId('reasoning-default')).toHaveTextContent('medium');
  });
});
