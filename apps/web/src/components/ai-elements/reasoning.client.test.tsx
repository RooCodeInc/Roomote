import { render } from '@testing-library/react';

import { Reasoning, ReasoningContent } from './reasoning';

describe('ReasoningContent', () => {
  it('preserves single-line breaks inside reasoning bubbles', () => {
    const { container } = render(
      <Reasoning open defaultOpen={false}>
        <ReasoningContent>
          {'Examining HTML and PWA Updates\nInvesting Code Updates in PWA'}
        </ReasoningContent>
      </Reasoning>,
    );

    expect(container.querySelector('br')).not.toBeNull();
  });
});
