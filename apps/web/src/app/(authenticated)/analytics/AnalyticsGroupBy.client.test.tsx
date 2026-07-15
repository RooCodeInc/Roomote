import { render, screen } from '@testing-library/react';

import { ANALYTICS_DIMENSION_LABELS, ANALYTICS_OBJECT_CONFIG } from '@/types';

import { AnalyticsGroupBy } from './AnalyticsGroupBy';

describe('AnalyticsGroupBy', () => {
  it('renders a By select trigger with the active dimension label', () => {
    render(
      <AnalyticsGroupBy
        object="pullRequests"
        value="user"
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'View by' });
    expect(trigger).toHaveTextContent('User');
  });

  it('exposes Model as a tasks group-by option', () => {
    expect(ANALYTICS_OBJECT_CONFIG.tasks.viewByDimensions).toContain('model');
    expect(ANALYTICS_DIMENSION_LABELS.model).toBe('Model');

    render(
      <AnalyticsGroupBy object="tasks" value="model" onChange={vi.fn()} />,
    );

    expect(screen.getByRole('combobox', { name: 'View by' })).toHaveTextContent(
      'Model',
    );
  });
});
