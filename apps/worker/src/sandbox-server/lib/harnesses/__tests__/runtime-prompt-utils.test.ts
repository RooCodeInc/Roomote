import {
  parseDataUriImage,
  isLikelyBase64,
  imageInputToPromptBlock,
} from '../runtime-prompt-utils';

describe('parseDataUriImage', () => {
  it('parses a valid data URI', () => {
    const result = parseDataUriImage('data:image/png;base64,aGVsbG8=');
    expect(result).toEqual({ mimeType: 'image/png', data: 'aGVsbG8=' });
  });

  it('trims whitespace', () => {
    const result = parseDataUriImage('  data:image/jpeg;base64,Zm9v  ');
    expect(result).toEqual({ mimeType: 'image/jpeg', data: 'Zm9v' });
  });

  it('returns undefined for non-data-URI strings', () => {
    expect(parseDataUriImage('not a data uri')).toBeUndefined();
    expect(parseDataUriImage('data:text/plain,hello')).toBeUndefined();
  });
});

describe('isLikelyBase64', () => {
  it('returns true for long base64 strings', () => {
    expect(isLikelyBase64('AAAAAAAAAAAAAAAA')).toBe(true);
    expect(isLikelyBase64('aGVsbG8gd29ybGQ=')).toBe(true);
  });

  it('returns false for short strings', () => {
    expect(isLikelyBase64('abc')).toBe(false);
  });

  it('returns false for strings with invalid characters', () => {
    expect(isLikelyBase64('not-valid-base64!!')).toBe(false);
  });
});

describe('imageInputToPromptBlock', () => {
  it('converts data URI to image block', () => {
    const result = imageInputToPromptBlock('data:image/png;base64,aGVsbG8=');
    expect(result).toEqual({
      type: 'image',
      data: 'aGVsbG8=',
      mimeType: 'image/png',
    });
  });

  it('converts raw base64 to image block with default mime type', () => {
    const result = imageInputToPromptBlock('AAAAAAAAAAAAAAAA');
    expect(result).toEqual({
      type: 'image',
      data: 'AAAAAAAAAAAAAAAA',
      mimeType: 'image/png',
    });
  });

  it('returns undefined for non-image strings', () => {
    expect(imageInputToPromptBlock('hello')).toBeUndefined();
  });
});
