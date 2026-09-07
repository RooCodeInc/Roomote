import { renderToStaticMarkup } from 'react-dom/server';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LocalDateTime } from './local-date-time';

describe('LocalDateTime', () => {
  const date = new Date('2026-05-01T12:34:00.000Z');

  it('emits no locale-dependent text when rendered on the server', () => {
    const html = renderToStaticMarkup(<LocalDateTime date={date} />);
    expect(html).toBe('<time dateTime="2026-05-01T12:34:00.000Z"></time>');
  });

  it('fills in the localized string after mount', () => {
    const { container } = render(<LocalDateTime date={date} />);
    const time = container.querySelector('time');
    expect(time).not.toBeNull();
    expect(time?.textContent).toBe(
      date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    );
  });

  it('honors custom format styles', () => {
    const { container } = render(
      <LocalDateTime date={date} dateStyle="full" timeStyle="long" />,
    );
    expect(container.querySelector('time')?.textContent).toBe(
      date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' }),
    );
  });
});
