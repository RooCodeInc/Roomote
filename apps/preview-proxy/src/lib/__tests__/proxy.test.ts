import { splitUpstreamAuth } from '../proxy';

describe('splitUpstreamAuth', () => {
  it('passes through targets without a token', () => {
    expect(splitUpstreamAuth('https://sandbox.modal.host')).toEqual({
      target: 'https://sandbox.modal.host',
    });
    expect(splitUpstreamAuth('http://localhost:3000/base?x=1')).toEqual({
      target: 'http://localhost:3000/base?x=1',
    });
  });

  it('strips the Box _token query into a _port_auth cookie', () => {
    expect(
      splitUpstreamAuth('https://box-61353.on.ascii.dev/?_token=abc123'),
    ).toEqual({
      target: 'https://box-61353.on.ascii.dev',
      authCookie: '_port_auth=abc123',
    });
  });

  it('preserves path and other query params when stripping the token', () => {
    expect(
      splitUpstreamAuth('https://box.on.test/base?_token=abc&keep=1'),
    ).toEqual({
      target: 'https://box.on.test/base?keep=1',
      authCookie: '_port_auth=abc',
    });
  });

  it('returns invalid targets untouched', () => {
    expect(splitUpstreamAuth('not-a-url')).toEqual({ target: 'not-a-url' });
  });
});
