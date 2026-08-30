const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));

import Page from './page';

it('redirects the shipped Brain settings URL to Memory', () => {
  expect(() => Page()).toThrow('NEXT_REDIRECT');
  expect(redirectMock).toHaveBeenCalledWith('/settings/memory');
});
