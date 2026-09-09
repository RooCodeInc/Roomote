import { render, screen, within } from '@testing-library/react';

import { CostBreakdownTable } from './CostBreakdownTable';

describe('CostBreakdownTable', () => {
  it.each([
    [999.99, 0.001, '$999.99', '$0.00'],
    [1000, 1.005, '$1,000.00', '$1.00'],
    [1234567.89, 1234.56, '$1,234,567.89', '$1,234.56'],
  ])(
    'formats total %s and average %s',
    (totalCost, averageCostPerTask, total, average) => {
      render(
        <CostBreakdownTable
          rows={[
            {
              key: 'test',
              provider: 'openai',
              model: 'test',
              totalCost,
              totalTokens: 1_230_000,
              costShare: 100,
              taskCount: 1,
              averageCostPerTask,
              averageTokensPerTask: 4_210_000_000,
              averageCostPerPr: null,
            },
          ]}
        />,
      );
      expect(screen.getByText(total)).toBeInTheDocument();
      expect(screen.getByText(average)).toBeInTheDocument();
      expect(screen.getByText('1.23M')).toBeInTheDocument();
      expect(screen.getByText('4.21B')).toBeInTheDocument();
    },
  );

  it('renders provider and model display names with tabular numeric values', () => {
    render(
      <CostBreakdownTable
        rows={[
          {
            key: 'openrouter:openrouter/openai/gpt-5.6-terra',
            provider: 'openrouter',
            model: 'openrouter/openai/gpt-5.6-terra',
            totalCost: 12.34,
            totalTokens: 0,
            costShare: 56.7,
            taskCount: 8,
            averageCostPerTask: 1.54,
            averageTokensPerTask: 0,
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
    expect(within(row).getAllByText('0')).toHaveLength(2);
  });
});
