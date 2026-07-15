import { render, screen, within } from '@testing-library/react';

import { CostBreakdownTable } from './CostBreakdownTable';

describe('CostBreakdownTable', () => {
  it('renders provider and model display names with tabular numeric values', () => {
    render(
      <CostBreakdownTable
        rows={[
          {
            key: 'openrouter:openrouter/openai/gpt-5.6-terra',
            provider: 'openrouter',
            model: 'openrouter/openai/gpt-5.6-terra',
            totalCost: 12.34,
            costShare: 56.7,
            taskCount: 8,
            averageCostPerTask: 1.54,
            averageCostPerPr: null,
          },
        ]}
      />,
    );

    const row = screen.getByRole('row', {
      name: /OpenRouter GPT 5.6 Terra/,
    });

    expect(within(row).getByText('OpenRouter')).toBeInTheDocument();
    expect(within(row).getByText('GPT 5.6 Terra')).toBeInTheDocument();
    expect(within(row).getByText('$12.34')).toHaveClass('tabular-nums');
    expect(within(row).getByText('56.7%')).toHaveClass('tabular-nums');
    expect(within(row).getByText('8')).toHaveClass('tabular-nums');
    expect(within(row).getByText('$1.54')).toHaveClass('tabular-nums');
  });
});
