import { render, screen } from '@testing-library/react';

import { StepTitle } from './StepTitle';

describe('StepTitle', () => {
  it('hides the checkbox by default', () => {
    const { container } = render(<StepTitle text="Setup title" />);

    expect(screen.getByText('Setup title')).toBeInTheDocument();
    expect(container.querySelector('.size-6')).toBeNull();
  });

  it('shows the checkbox when showCheckbox is true', () => {
    const { container } = render(
      <StepTitle text="Onboarding title" showCheckbox={true} />,
    );

    expect(screen.getByText('Onboarding title')).toBeInTheDocument();
    expect(container.querySelector('.absolute.-left-6')).toBeTruthy();
  });
});
