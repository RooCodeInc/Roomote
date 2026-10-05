import { fireEvent, render, screen } from '@testing-library/react';

import { Calendar } from '@/components/system';

import { SettingSummaryRow } from './SettingSummaryRow';

describe('SettingSummaryRow', () => {
  it('renders the shared icon, value, and edit action', () => {
    const onEdit = vi.fn();

    render(
      <SettingSummaryRow
        icon={Calendar}
        label="Schedule"
        value="Daily"
        onEdit={onEdit}
      />,
    );

    expect(screen.getByText('Schedule:')).toBeInTheDocument();
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(document.querySelector('svg.lucide-calendar')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledOnce();
  });
});
