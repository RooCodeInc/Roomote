import { decodeInferenceErrorEnvelope } from '../inference-error-envelope';

describe('decodeInferenceErrorEnvelope', () => {
  it.each(['classification', 'content-filter', 'display'] as const)(
    'bounds %s decoding at depth four and terminates cycles',
    (policy) => {
      const beyond = { message: 'beyond' };
      const boundary = { error: beyond };
      const root = { error: { error: { error: { error: boundary } } } };
      Object.assign(boundary, { cause: root });
      const values = [...decodeInferenceErrorEnvelope(root, policy)];
      expect(values).toContain(boundary);
      expect(values).not.toContain(beyond);
      expect(values.filter((value) => value === root)).toHaveLength(1);
    },
  );

  it('counts JSON decoding as a depth and preserves breadth-first order', () => {
    const root = {
      error: { error: { error: { responseBody: '{"status":429}' } } },
      cause: { message: 'sibling' },
    };
    const values = [...decodeInferenceErrorEnvelope(root, 'display')];
    expect(values.slice(0, 3)).toEqual([root, root.cause, root.error]);
    expect(values).toContain('{"status":429}');
    expect(values).not.toContainEqual({ status: 429 });
  });

  it('keeps broad JSON and array decoding out of display', () => {
    const root = { extra: [{ status: 401 }], responseBody: '[{"status":429}]' };
    expect([
      ...decodeInferenceErrorEnvelope(root, 'classification'),
    ]).toContainEqual({ status: 401 });
    expect([
      ...decodeInferenceErrorEnvelope(root, 'classification'),
    ]).toContainEqual({ status: 429 });
    expect([...decodeInferenceErrorEnvelope(root, 'display')]).toEqual([
      root,
      root.responseBody,
    ]);
  });

  it('only content-filter decoding follows non-enumerable name/message', () => {
    const root = new Error('{"statusCode":401,"isRetryable":false}');
    expect([...decodeInferenceErrorEnvelope(root, 'classification')]).toEqual([
      root,
    ]);
    expect([
      ...decodeInferenceErrorEnvelope(root, 'content-filter'),
    ]).toContainEqual({ statusCode: 401, isRetryable: false });
    expect([...decodeInferenceErrorEnvelope(root, 'display')]).toEqual([root]);
  });

  it('display follows inherited named fields but classification only enumerable values', () => {
    const cause = { status: 401 };
    const root = Object.create({ cause }) as Record<string, unknown>;
    expect([...decodeInferenceErrorEnvelope(root, 'display')]).toEqual([
      root,
      cause,
    ]);
    expect([...decodeInferenceErrorEnvelope(root, 'classification')]).toEqual([
      root,
    ]);
  });

  it('lets consumers stop before accessing nested values', () => {
    const root = {
      status: 401,
      get error(): unknown {
        throw new Error('must not read');
      },
    };
    const decoder = decodeInferenceErrorEnvelope(root, 'classification');
    expect(decoder.next().value).toBe(root);
    decoder.return(undefined);
  });
});
