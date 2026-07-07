import { render, screen } from '@testing-library/react';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/task/task-1',
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/app/(sandbox)/task/[taskId]/hooks/ArtifactLinkProvider', () => ({
  useArtifactLink: () => null,
}));

import { CustomParagraph, MessagePlainText, MessageResponse } from './message';

describe('message wrapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies overflow wrapping safeguards to plain text messages', () => {
    render(<MessagePlainText>longUnbrokenIdentifier</MessagePlainText>);

    const text = screen.getByText('longUnbrokenIdentifier');

    expect(text.className).toContain('min-w-0');
    expect(text.className).toContain('[overflow-wrap:anywhere]');
  });

  it('applies overflow wrapping safeguards to markdown paragraphs', () => {
    render(<CustomParagraph>longUnbrokenIdentifier</CustomParagraph>);

    const paragraph = screen.getByText('longUnbrokenIdentifier');

    expect(paragraph.className).toContain('min-w-0');
    expect(paragraph.className).toContain('[overflow-wrap:anywhere]');
  });

  it('keeps the markdown response root shrinkable', () => {
    const { container } = render(
      <MessageResponse>longUnbrokenIdentifier</MessageResponse>,
    );

    const response = container.firstElementChild;

    expect(response).not.toBeNull();
    expect(response?.className).toContain('min-w-0');
    expect(response?.className).toContain('[overflow-wrap:anywhere]');
    expect(response?.className).toContain('[&>*]:min-w-0');
  });

  it('autolinks plain URL literals in assistant markdown', () => {
    render(
      <MessageResponse>
        Visit https://example.com/docs for the latest docs.
      </MessageResponse>,
    );

    const link = screen.getByRole('link', { name: 'https://example.com/docs' });

    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps trailing punctuation outside autolinked URLs', () => {
    const { container } = render(
      <MessageResponse>Visit https://example.com/docs.</MessageResponse>,
    );

    const link = screen.getByRole('link', { name: 'https://example.com/docs' });

    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(container).toHaveTextContent('Visit https://example.com/docs.');
  });

  it('leaves explicit markdown links intact', () => {
    render(
      <MessageResponse>
        [External docs](https://example.com/docs)
      </MessageResponse>,
    );

    const link = screen.getByRole('link', { name: 'External docs' });

    expect(link).toHaveAttribute('href', 'https://example.com/docs');
  });

  it('autolinks plain URLs inside brackets when they are not markdown links', () => {
    render(<MessageResponse>{'[https://example.com/docs]'}</MessageResponse>);

    const link = screen.getByRole('link', { name: 'https://example.com/docs' });

    expect(link).toHaveAttribute('href', 'https://example.com/docs');
  });

  it('keeps markdown links intact when the label is itself a URL', () => {
    render(
      <MessageResponse>
        [https://example.com/docs](https://docs.roomote.dev)
      </MessageResponse>,
    );

    const link = screen.getByRole('link', { name: 'https://example.com/docs' });

    expect(link).toHaveAttribute('href', 'https://docs.roomote.dev/');
  });

  it('does not autolink inside reference-style markdown links', () => {
    const { container } = render(
      <MessageResponse>
        {'[https://example.com/docs][docs]\n\n[docs]: https://docs.roomote.dev'}
      </MessageResponse>,
    );

    expect(
      container.querySelector('a[href="https://example.com/docs%5D%5Bdocs"]'),
    ).toBeNull();
  });
});
