import { render, screen } from '@testing-library/react';

import { ModelBadge } from './ModelBadge';

describe('ModelBadge', () => {
  it('prefers a provided display name', () => {
    render(
      <ModelBadge model="openrouter/openai/gpt-5.5" displayName="GPT 5.5" />,
    );

    expect(screen.getByText('GPT 5.5')).toBeInTheDocument();
    expect(
      screen.queryByText('openrouter/openai/gpt-5.5'),
    ).not.toBeInTheDocument();
  });
});
