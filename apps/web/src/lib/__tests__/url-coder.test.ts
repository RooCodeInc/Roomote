import { encodeRecord, decodeRecord } from '../url-coder';

describe('encodeRecord and decodeRecord', () => {
  it('should encode and decode a simple object', () => {
    const original = { key: 'value', number: 123 };
    const encoded = encodeRecord(original);
    const decoded = decodeRecord(encoded);

    expect(decoded).toEqual(original);
  });

  it('should encode and decode an object with special characters', () => {
    const original = {
      url: 'https://example.com/path?query=value&other=123',
      special: 'hello@world.com',
      timestamp: '2024-01-01T00:00:00.000Z',
    };
    const encoded = encodeRecord(original);
    const decoded = decodeRecord(encoded);

    expect(decoded).toEqual(original);
  });

  it('should handle URL encoding properly', () => {
    const original = {
      url: 'https://example.com/path?query=value&other=123',
      special: 'hello@world.com',
    };
    const encoded = encodeRecord(original);

    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');

    const decoded = decodeRecord(encoded);
    expect(decoded).toEqual(original);
  });

  it('should return undefined for invalid base64', () => {
    const decoded = decodeRecord('not-valid-base64!!!');
    expect(decoded).toBeUndefined();
  });

  it('should return undefined for invalid JSON', () => {
    const invalidJson = encodeURIComponent(btoa('not json'));
    const decoded = decodeRecord(invalidJson);
    expect(decoded).toBeUndefined();
  });

  it('should return undefined for invalid URL encoding', () => {
    const decoded = decodeRecord('%%%invalid%%%');
    expect(decoded).toBeUndefined();
  });

  it('should handle state for GitHub App connection', () => {
    const state = {
      redirect: '/cloud-agents',
      action: 'create',
      agentId: 'new-agent-123',
    };

    const encoded = encodeRecord(state);
    const decoded = decodeRecord(encoded);
    expect(decoded).toEqual(state);
  });

  it('should handle complex state objects', () => {
    const state = {
      redirect: '/dashboard',
      params: 'key1=value1&key2=value2',
      timestamp: '2024-01-01T00:00:00Z',
      special: 'test@example.com',
    };

    const encoded = encodeRecord(state);
    const decoded = decodeRecord(encoded);
    expect(decoded).toEqual(state);
  });
});
