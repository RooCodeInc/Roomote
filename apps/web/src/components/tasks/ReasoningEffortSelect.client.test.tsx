import { render, screen } from '@testing-library/react';

import { ReasoningEffortSelect } from './ReasoningEffortSelect';

describe('ReasoningEffortSelect', () => {
  it('shows a neutral placeholder when no default has resolved', () => {
    render(
      <ReasoningEffortSelect
        value={null}
        defaultEffort={null}
        onChange={vi.fn()}
        ariaLabel="Session reasoning level"
      />,
    );

    expect(
      screen.getByRole('combobox', { name: 'Session reasoning level' }),
    ).toHaveTextContent('Reasoning');
  });
});
