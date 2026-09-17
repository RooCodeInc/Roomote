import { redirectUnauthorizedError } from './query-client';

describe('redirectUnauthorizedError', () => {
  it('redirects expired sessions back to the current page after sign-in', () => {
    const assign = vi.fn();

    expect(
      redirectUnauthorizedError(
        { data: { code: 'UNAUTHORIZED' } },
        {
          assign,
          pathname: '/sessions/session-1',
          search: '?panel=task-1',
        },
      ),
    ).toBe(true);
    expect(assign).toHaveBeenCalledWith(
      '/sign-in?redirect_url=%2Fsessions%2Fsession-1%3Fpanel%3Dtask-1',
    );
  });

  it.each(['/sign-in', '/sign-in/oauth'])(
    'does not redirect an unauthenticated %s page back to itself',
    (pathname) => {
      const assign = vi.fn();

      expect(
        redirectUnauthorizedError(
          { data: { code: 'UNAUTHORIZED' } },
          {
            assign,
            pathname,
            search: '?redirect_url=%2Fsetup',
          },
        ),
      ).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it.each([
    new Error('UNAUTHORIZED'),
    { data: { code: 'FORBIDDEN' } },
    { data: null },
  ])('leaves non-authentication errors to their caller', (error) => {
    const assign = vi.fn();

    expect(
      redirectUnauthorizedError(error, {
        assign,
        pathname: '/sessions/session-1',
        search: '',
      }),
    ).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});
