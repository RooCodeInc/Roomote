import { render, screen } from '@testing-library/react';

import { SessionSearchSnippet } from './SessionSearchSnippet';

describe('SessionSearchSnippet', () => {
  it('emphasizes the matching phrase case-insensitively', () => {
    render(
      <SessionSearchSnippet
        snippet="...Preserve the Heliotrope detail before release."
        query="heliotrope"
      />,
    );

    const match = screen.getByText('Heliotrope');
    expect(match).toHaveProperty('tagName', 'MARK');
    expect(match.parentElement).toHaveTextContent(
      '...Preserve the Heliotrope detail before release.',
    );
  });

  it('renders contextual text without emphasis when the query is absent', () => {
    render(<SessionSearchSnippet snippet="Context only" query="" />);

    expect(screen.getByText('Context only')).toBeVisible();
    expect(document.querySelector('mark')).toBeNull();
  });

  it('renders nothing without a safe snippet', () => {
    const { container } = render(
      <SessionSearchSnippet snippet={null} query="private" />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
