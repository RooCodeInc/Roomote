import { z } from 'zod';

import { withNullableOptionals } from '../nullable-optionals.js';

describe('withNullableOptionals', () => {
  const shape = withNullableOptionals({
    action: z.enum(['get', 'update']).describe('required action'),
    threadId: z.string().optional().describe('optional thread id'),
    issueNumber: z
      .number()
      .int()
      .refine((value) => value > 0, {
        message: 'Issue number must be positive.',
      })
      .optional(),
    labels: z.array(z.string()).optional(),
    note: z.string().nullable().optional(),
  });
  const schema = z.object(shape);

  it('maps null on optional fields to undefined for the handler', () => {
    expect(
      schema.parse({
        action: 'get',
        threadId: null,
        issueNumber: null,
        labels: null,
      }),
    ).toEqual({
      action: 'get',
      threadId: undefined,
      issueNumber: undefined,
      labels: undefined,
    });
  });

  it('still accepts omitted and real values', () => {
    expect(schema.parse({ action: 'get' })).toEqual({ action: 'get' });
    expect(
      schema.parse({ action: 'update', threadId: 'T1', issueNumber: 7 }),
    ).toEqual({ action: 'update', threadId: 'T1', issueNumber: 7 });
  });

  it('keeps inner refinements for non-null values', () => {
    expect(() => schema.parse({ action: 'get', issueNumber: 0 })).toThrow(
      'Issue number must be positive.',
    );
  });

  it('leaves required fields non-nullable', () => {
    expect(() => schema.parse({ action: null })).toThrow();
    expect(shape.action).toBeInstanceOf(z.ZodEnum);
  });

  it('exposes null on the wire schema and preserves descriptions', () => {
    expect(shape.threadId).toBeInstanceOf(z.ZodOptional);
    expect(shape.threadId.description).toBe('optional thread id');
    const inner = (shape.threadId as z.ZodOptional<z.ZodTypeAny>).unwrap();
    expect(inner).toBeInstanceOf(z.ZodEffects);
    expect((inner as z.ZodEffects<z.ZodTypeAny>).innerType()).toBeInstanceOf(
      z.ZodNullable,
    );
  });

  it('does not double-wrap fields that already accept null', () => {
    expect((shape.note as z.ZodOptional<z.ZodTypeAny>).unwrap()).toBeInstanceOf(
      z.ZodNullable,
    );
    expect(schema.parse({ action: 'get', note: null })).toEqual({
      action: 'get',
      note: null,
    });
  });

  it('passes through undefined and non-shape schemas unchanged', () => {
    expect(withNullableOptionals(undefined)).toBeUndefined();
    const object = z.object({ a: z.string().optional() });
    expect(withNullableOptionals(object)).toBe(object);
  });
});
