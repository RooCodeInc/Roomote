import { render, screen } from '@testing-library/react';

import { TaskHeaderMetadata } from './TaskHeader';

describe('TaskHeaderMetadata', () => {
  it('shows the existing private indicator beside a private task model', () => {
    render(
      <TaskHeaderMetadata
        model="openrouter/openai/gpt-5.5"
        privacy="private"
      />,
    );

    expect(screen.getByText('openrouter/openai/gpt-5.5')).toBeInTheDocument();
    expect(screen.getByLabelText('Private session')).toBeInTheDocument();
  });

  it('does not show the private indicator for a shared task', () => {
    render(
      <TaskHeaderMetadata model="openrouter/openai/gpt-5.5" privacy="shared" />,
    );

    expect(screen.queryByLabelText('Private session')).not.toBeInTheDocument();
  });
});
