import { classifyProxyFailure } from '../proxy-failure';

describe('classifyProxyFailure', () => {
  it('treats an aborted request signal as an expected client cancellation', () => {
    const controller = new AbortController();
    controller.abort(new DOMException('client disconnected', 'AbortError'));

    expect(
      classifyProxyFailure(new Error('aborted'), controller.signal),
    ).toEqual({
      outcome: 'client_cancelled',
      expected: true,
      retryable: false,
    });
  });

  it('keeps timeout cancellation expected but retryable', () => {
    const controller = new AbortController();
    controller.abort(new DOMException('timed out', 'TimeoutError'));

    expect(
      classifyProxyFailure(new Error('aborted'), controller.signal),
    ).toEqual({
      outcome: 'timeout',
      expected: true,
      retryable: true,
    });
  });

  it('distinguishes an upstream transport abort from client cancellation', () => {
    expect(
      classifyProxyFailure(
        Object.assign(new Error('aborted'), {
          code: 'UND_ERR_ABORTED',
        }),
      ),
    ).toEqual({
      outcome: 'transport_abort',
      expected: false,
      retryable: true,
    });
  });

  it('classifies other failures as retryable transport errors', () => {
    expect(classifyProxyFailure(new Error('socket closed'))).toEqual({
      outcome: 'transport_error',
      expected: false,
      retryable: true,
    });
  });
});
