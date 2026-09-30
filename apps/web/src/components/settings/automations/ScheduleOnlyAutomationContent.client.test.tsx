import { fireEvent, render, screen } from '@testing-library/react';

import { ScheduleOnlyAutomationContent } from './ScheduleOnlyAutomationContent';

describe('ScheduleOnlyAutomationContent', () => {
  it('renders the CI triage toggle for toggle-based automations', () => {
    render(
      <ScheduleOnlyAutomationContent
        automationLabel="CI Failure Triage"
        control={{
          kind: 'toggle',
          enabledFrequency: 'daily',
          enabledLabel: 'Investigate CI failures as they happen',
        }}
        details={[]}
        frequency="off"
        isEnabled={false}
        disabled={false}
        fieldId="ci-failure-triage-frequency"
        onFrequencyChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('switch', { name: 'CI Failure Triage enabled' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Investigate CI failures as they happen'),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('CI Failure Triage schedule'),
    ).not.toBeInTheDocument();
  });

  it('keeps schedule editing collapsed and omits repeated details', () => {
    const details = [
      'Reviews merged PRs since the last run.',
      'Posts only actionable follow-up work.',
    ] as const;

    const { rerender } = render(
      <ScheduleOnlyAutomationContent
        automationLabel="Code Quality Auditor"
        control={{
          kind: 'schedule',
          scheduleOptions: [
            { value: 'off', label: 'Off' },
            { value: 'daily', label: 'Daily' },
          ],
        }}
        details={details}
        frequency="off"
        isEnabled={false}
        disabled={false}
        fieldId="code-quality-auditor-frequency"
        onFrequencyChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Code Quality Auditor schedule'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(details[0])).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(
      screen.getByLabelText('Code Quality Auditor schedule'),
    ).toBeInTheDocument();

    rerender(
      <ScheduleOnlyAutomationContent
        automationLabel="Code Quality Auditor"
        control={{
          kind: 'schedule',
          scheduleOptions: [
            { value: 'off', label: 'Off' },
            { value: 'daily', label: 'Daily' },
          ],
        }}
        details={details}
        frequency="daily"
        isEnabled={true}
        disabled={false}
        fieldId="code-quality-auditor-frequency"
        onFrequencyChange={vi.fn()}
      />,
    );

    expect(screen.queryByText(details[0])).not.toBeInTheDocument();
    expect(screen.queryByText(details[1])).not.toBeInTheDocument();
  });
});
