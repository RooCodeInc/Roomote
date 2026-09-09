import { render, screen, fireEvent } from '@testing-library/react';
import { CiFailureTriageAdditionalRules } from './CiFailureTriageAdditionalRules';

it('keeps the standard destination visible while editing free text and displays save errors', () => {
  const onChange = vi.fn();
  render(
    <CiFailureTriageAdditionalRules
      value="Only triage backend"
      onChange={onChange}
      error="Which workspace?"
      globalDestination={<button>Standard destination</button>}
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Standard destination' }),
  ).toBeInTheDocument();
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Additional rules (optional)' }),
    { target: { value: 'Focus on flaky tests; keep reports concise.' } },
  );
  expect(onChange).toHaveBeenCalledWith(
    'Focus on flaky tests; keep reports concise.',
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Which workspace?');
  expect(screen.queryByText('Repository scope')).not.toBeInTheDocument();
});
