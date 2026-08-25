import { render, screen } from '@testing-library/react';

import { FastSessionTranscript } from './FastSessionTranscript';

describe('FastSessionTranscript', () => {
  it('renders persisted user and assistant text with task transcript primitives', () => {
    render(
      <FastSessionTranscript
        messages={[
          { id: 'user-1', role: 'user', text: 'What changed?' },
          { id: 'assistant-1', role: 'assistant', text: '**Two files**' },
        ]}
        footer={<p>Transcript limitation</p>}
      />,
    );

    expect(screen.getByRole('log')).toBeInTheDocument();
    expect(screen.getByText('What changed?')).toBeInTheDocument();
    expect(screen.getByText('Two files')).toBeInTheDocument();
    expect(screen.getByText('Transcript limitation')).toBeInTheDocument();
  });
});
