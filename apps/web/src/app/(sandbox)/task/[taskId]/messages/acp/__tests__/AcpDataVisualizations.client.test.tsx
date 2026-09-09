import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AcpDataVisualizations } from '../AcpDataVisualizations';

const rechartsState = vi.hoisted(() => ({
  lineProps: [] as Array<Record<string, unknown>>,
  xAxisProps: [] as Array<Record<string, unknown>>,
  yAxisProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('recharts', () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );

  return {
    ResponsiveContainer: Container,
    AreaChart: Container,
    BarChart: Container,
    LineChart: Container,
    PieChart: Container,
    Area: () => null,
    Bar: () => null,
    CartesianGrid: () => null,
    Cell: () => null,
    Legend: () => null,
    Line: (props: Record<string, unknown>) => {
      rechartsState.lineProps.push(props);
      return null;
    },
    Pie: Container,
    Tooltip: () => null,
    XAxis: (props: Record<string, unknown>) => {
      rechartsState.xAxisProps.push(props);
      return null;
    },
    YAxis: (props: Record<string, unknown>) => {
      rechartsState.yAxisProps.push(props);
      return null;
    },
  };
});

describe('AcpDataVisualizations', () => {
  beforeEach(() => {
    rechartsState.lineProps = [];
    rechartsState.xAxisProps = [];
    rechartsState.yAxisProps = [];
  });

  it('renders responsive charts with an accessible data table fallback', () => {
    render(
      <AcpDataVisualizations
        charts={[
          {
            type: 'data_visualization',
            title: 'Weekly sales',
            chart: {
              type: 'line',
              series: [
                {
                  name: 'Online',
                  data: [
                    { label: 'Week 1', value: 12 },
                    { label: 'Week 2', value: 18 },
                  ],
                },
              ],
              axis_config: {
                categories: ['Week 1', 'Week 2'],
                x_label: 'Week',
                y_label: 'Sales',
              },
            },
          },
        ]}
      />,
    );

    const figure = screen.getByRole('figure', { name: 'Weekly sales' });
    expect(figure).toHaveClass('min-w-0');
    expect(screen.getByText('View data table')).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Week' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Online' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('rowheader', { name: 'Week 2' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '18' })).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Weekly sales data table' }),
    ).toHaveAttribute('tabindex', '0');
    expect(rechartsState.lineProps[0]).toMatchObject({
      stroke: 'var(--color-chart-4)',
      strokeWidth: 3,
      activeDot: { r: 5 },
      isAnimationActive: false,
    });
    expect(rechartsState.xAxisProps[0]).toMatchObject({
      tick: { fill: 'var(--color-foreground)', fontSize: 12 },
      padding: { left: 10, right: 18 },
    });
    expect(rechartsState.yAxisProps[0]).toMatchObject({
      width: 64,
      tick: { fill: 'var(--color-foreground)', fontSize: 12 },
    });
    expect(
      (rechartsState.yAxisProps[0]?.tickFormatter as (value: number) => string)(
        125_000,
      ),
    ).toBe('125K');
  });

  it('renders pie segment values in the fallback table', () => {
    render(
      <AcpDataVisualizations
        charts={[
          {
            type: 'data_visualization',
            title: 'Traffic sources',
            chart: {
              type: 'pie',
              segments: [
                { label: 'Search', value: 65 },
                { label: 'Direct', value: 35 },
              ],
            },
          },
        ]}
      />,
    );

    expect(
      screen.getByRole('rowheader', { name: 'Search' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '65' })).toBeInTheDocument();
  });
});
