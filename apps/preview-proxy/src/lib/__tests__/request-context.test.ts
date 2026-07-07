import {
  getRequestContext,
  runWithRequestContext,
  setRequestContext,
} from '../request-context';

describe('request context', () => {
  it('merges later updates into the current context', () => {
    runWithRequestContext(
      {
        requestId: 'req-123',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        host: 'test.example.com',
        method: 'GET',
        path: '/',
      },
      () => {
        setRequestContext({
          upstreamTarget: 'http://sandbox.example.com:3000',
        });

        expect(getRequestContext()).toMatchObject({
          requestId: 'req-123',
          upstreamTarget: 'http://sandbox.example.com:3000',
        });
      },
    );
  });

  it('isolates request contexts per run', () => {
    runWithRequestContext(
      {
        requestId: 'req-1',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
      () => {
        expect(getRequestContext()?.requestId).toBe('req-1');
      },
    );

    expect(getRequestContext()).toBeUndefined();
  });
});
