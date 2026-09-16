import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { bearer } from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';

/**
 * The iOS app carries the web session as a bearer token. This pins the
 * better-auth behavior the mobile auth path relies on: a sign-in response
 * exposes the signed token in `set-auth-token`, and `auth.api.getSession`
 * resolves it from an `Authorization` header with no cookie at all.
 */
describe('bearer sessions', () => {
  it('resolves a session from the token echoed at sign-in', async () => {
    const auth = betterAuth({
      baseURL: 'http://localhost:3000',
      secret: 'test-secret-test-secret-test-secret',
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      emailAndPassword: { enabled: true },
      plugins: [bearer({ requireSignature: true })],
    });
    const signUp = await auth.api.signUpEmail({
      body: {
        email: 'ios@roomote.test',
        password: 'correct horse battery',
        name: 'iOS',
      },
      returnHeaders: true,
    });
    const token = signUp.headers.get('set-auth-token');
    expect(token).toMatch(/^[^.]+\.[^.]+$/);

    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(session?.user.email).toBe('ios@roomote.test');

    const forged = await auth.api.getSession({
      headers: new Headers({
        authorization: `Bearer ${token!.split('.')[0]}.bad`,
      }),
    });
    expect(forged).toBeNull();

    const unsigned = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token!.split('.')[0]}` }),
    });
    expect(unsigned).toBeNull();
  });
});
