import { render } from '@testing-library/react';

import Page from './page';

const originalLocation = window.location;

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

it('sends the old Settings integrations URL to the Integrations page with its query and hash', () => {
  const replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      ...originalLocation,
      search: '?highlight=sentry-mcp&mcp=connected',
      hash: '#custom-mcp',
      replace,
    },
  });

  render(<Page />);

  expect(replace).toHaveBeenCalledWith(
    '/integrations?highlight=sentry-mcp&mcp=connected#custom-mcp',
  );
});
