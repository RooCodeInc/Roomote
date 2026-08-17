import { describe, expect, it } from 'vitest';

import {
  asBoolean,
  asFiniteInt,
  asFiniteNumber,
  asPositiveInt,
  asRecord,
  asRecordOrNull,
  asString,
  asStringOrNull,
} from '../primitives';

describe('asRecord', () => {
  it('returns plain objects unchanged', () => {
    const value = { a: 1 };
    expect(asRecord(value)).toBe(value);
    expect(asRecord({})).toEqual({});
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [1, 2]],
    ['a string', 'nope'],
    ['a number', 1],
    ['a boolean', true],
    ['a function', () => {}],
  ])('rejects %s', (_label, value) => {
    expect(asRecord(value)).toBeUndefined();
  });

  it('coerces misses to null via asRecordOrNull', () => {
    expect(asRecordOrNull([1])).toBeNull();
    expect(asRecordOrNull({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('asString', () => {
  it('accepts strings, including empty ones', () => {
    expect(asString('')).toBe('');
    expect(asString('hello')).toBe('hello');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['a boolean', false],
    ['an object', {}],
  ])('rejects %s', (_label, value) => {
    expect(asString(value)).toBeUndefined();
  });

  it('coerces misses to null via asStringOrNull', () => {
    expect(asStringOrNull(1)).toBeNull();
    expect(asStringOrNull('')).toBe('');
  });
});

describe('asBoolean', () => {
  it('accepts only real booleans', () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean('true')).toBeUndefined();
    expect(asBoolean(1)).toBeUndefined();
    expect(asBoolean(0)).toBeUndefined();
    expect(asBoolean(null)).toBeUndefined();
  });
});

describe('asFiniteNumber', () => {
  it.each([
    [0, 0],
    [42, 42],
    [-42, -42],
    // Truncates toward zero rather than rounding.
    [1.9, 1],
    [-1.9, -1],
    // Numeric strings are accepted and truncated the same way.
    ['42', 42],
    ['  42  ', 42],
    ['3.7', 3],
    ['-3.7', -3],
  ])('coerces %j to %j', (value, expected) => {
    expect(asFiniteNumber(value)).toBe(expected);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['a non-numeric string', 'abc'],
    ['a partially numeric string', '42abc'],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
  ])('rejects %s', (_label, value) => {
    expect(asFiniteNumber(value)).toBeUndefined();
  });

  it('coerces misses to null via asFiniteInt', () => {
    expect(asFiniteInt('abc')).toBeNull();
    expect(asFiniteInt('3.7')).toBe(3);
  });
});

describe('asPositiveInt', () => {
  it.each([
    [1, 1],
    [42, 42],
    ['42', 42],
    [1.9, 1],
  ])('accepts %j as %j', (value, expected) => {
    expect(asPositiveInt(value)).toBe(expected);
  });

  it.each([
    ['zero', 0],
    ['a negative number', -1],
    // Truncates to 0, which is not positive.
    ['a fraction below one', 0.9],
    ['a non-numeric string', 'abc'],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(asPositiveInt(value)).toBeUndefined();
  });
});
