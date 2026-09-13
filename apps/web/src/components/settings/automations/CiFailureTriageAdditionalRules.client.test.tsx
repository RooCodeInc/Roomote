import { render, screen, fireEvent } from '@testing-library/react';
import { AutomationAdditionalRules } from './CiFailureTriageAdditionalRules';

it('keeps the standard destination visible while editing free text and displays save errors', () => {
  const onChange = vi.fn();
  render(
    <AutomationAdditionalRules
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

it('derives automation-specific copy from registry metadata', () => {
  render(
    <AutomationAdditionalRules
      automationKey="suggester"
      value=""
      onChange={() => {}}
      globalDestination={<button>Suggestion destination</button>}
    />,
  );

  expect(screen.getByRole('textbox')).toHaveAttribute(
    'placeholder',
    expect.stringContaining('Only suggest work'),
  );
  expect(screen.getByText(/suggest work for all repositories/)).toBeVisible();
});
