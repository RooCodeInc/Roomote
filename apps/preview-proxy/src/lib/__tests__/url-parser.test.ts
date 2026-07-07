import {
  parseHost,
  parseHostWithSuffix,
  parseHostNested,
  stripSuffixFromHost,
  parseHostForConfig,
} from '../url-parser';

describe('parseHost', () => {
  describe('valid hosts', () => {
    it('should parse a 13-char base36 taskId', () => {
      const result = parseHost('3579x1khed4zp-web.preview.roomote.run');

      expect(result.isValid).toBe(true);
      expect(result.taskId).toBe('3579x1khed4zp');
      expect(result.portName).toBe('web');
    });

    it('should parse taskId with different domains', () => {
      const result = parseHost('20imtw24sm6hv-web.preview-john.ngrok.app');

      expect(result.isValid).toBe(true);
      expect(result.portName).toBe('web');
      expect(result.taskId).toBe('20imtw24sm6hv');
    });

    it('should parse taskId with sslip.io domain', () => {
      const result = parseHost('20imtw24sm6hv-web.127.0.0.1.sslip.io');

      expect(result.isValid).toBe(true);
      expect(result.portName).toBe('web');
      expect(result.taskId).toBe('20imtw24sm6hv');
    });

    it('should parse taskId with any arbitrary domain', () => {
      const result = parseHost('20imtw24sm6hv-api.any-domain.com');

      expect(result.isValid).toBe(true);
      expect(result.portName).toBe('api');
      expect(result.taskId).toBe('20imtw24sm6hv');
    });

    it('should parse taskId with multi-segment port name', () => {
      const result = parseHost('3579x1khed4zp-my-api-v2.preview.roomote.run');

      expect(result.isValid).toBe(true);
      expect(result.taskId).toBe('3579x1khed4zp');
      expect(result.portName).toBe('my-api-v2');
    });

    it('should normalize port name to lowercase', () => {
      const result = parseHost('3579x1khed4zp-WEB.preview.roomote.run');

      expect(result.isValid).toBe(true);
      expect(result.portName).toBe('web');
    });

    it('should accept port names with hyphens and numbers', () => {
      const result = parseHost('20imtw24sm6hv-api-v2.roomote-preview.dev');

      expect(result.isValid).toBe(true);
      expect(result.portName).toBe('api-v2');
    });

    it('should accept port names with multiple hyphens', () => {
      const result = parseHost(
        '20imtw24sm6hv-my-api-v2-beta.roomote-preview.dev',
      );

      expect(result.isValid).toBe(true);
      expect(result.portName).toBe('my-api-v2-beta');
    });

    it('should accept single character port names', () => {
      const result = parseHost('20imtw24sm6hv-a.roomote-preview.dev');

      expect(result.isValid).toBe(true);
      expect(result.portName).toBe('a');
    });
  });

  describe('invalid hosts', () => {
    it('should reject hosts with invalid characters', () => {
      const result = parseHost('not-a-valid!id-web.roomote-preview.dev');

      expect(result.isValid).toBe(false);
    });

    it('should reject port names with special characters', () => {
      const result = parseHost('20imtw24sm6hv-web@api.roomote-preview.dev');

      expect(result.isValid).toBe(false);
    });

    it('should reject port names with underscores', () => {
      const result = parseHost('20imtw24sm6hv-web_api.roomote-preview.dev');

      expect(result.isValid).toBe(false);
    });

    it('should reject identifiers that are too short', () => {
      const result = parseHost('k5lx9czk-web.preview.roomote.run');

      expect(result.isValid).toBe(false);
    });

    it('should reject identifiers that are 9 chars', () => {
      const result = parseHost('k5lx9czka-web.preview.roomote.run');

      expect(result.isValid).toBe(false);
    });

    it('should reject identifiers that are 10 chars', () => {
      const result = parseHost('k5lx9czkab-web.preview.roomote.run');

      expect(result.isValid).toBe(false);
    });

    it('should reject UUID format (no longer supported)', () => {
      const result = parseHost(
        '550e8400-e29b-41d4-a716-446655440000-web.roomote-preview.dev',
      );

      expect(result.isValid).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty host', () => {
      const result = parseHost('');

      expect(result.isValid).toBe(false);
    });

    it('should reject host without any domain (no dot)', () => {
      const result = parseHost('20imtw24sm6hv-web');

      expect(result.isValid).toBe(false);
    });

    it('should handle host that is just a domain', () => {
      const result = parseHost('roomote-preview.dev');

      expect(result.isValid).toBe(false);
    });

    it('should handle subdomain that is too short', () => {
      const result = parseHost('abc.roomote-preview.dev');

      expect(result.isValid).toBe(false);
    });
  });
});

describe('parseHostWithSuffix', () => {
  const outerTaskId = '20imtw24sm6hv';
  const suffix = `${outerTaskId}-preview`;

  it('should strip suffix and parse inner taskId', () => {
    const innerTaskId = '3579x1khed4zp';
    const host = `${innerTaskId}-web-${suffix}.preview.roomote.run`;

    const result = parseHostWithSuffix(host, suffix);

    expect(result.isValid).toBe(true);
    expect(result.taskId).toBe(innerTaskId);
    expect(result.portName).toBe('web');
  });

  it('should return invalid when suffix is missing', () => {
    const innerTaskId = '3579x1khed4zp';
    const host = `${innerTaskId}-web.preview.roomote.run`;

    const result = parseHostWithSuffix(host, suffix);

    expect(result.isValid).toBe(false);
  });

  it('should return invalid when suffix is in wrong position', () => {
    const host = `${suffix}-web.preview.roomote.run`;

    const result = parseHostWithSuffix(host, suffix);

    expect(result.isValid).toBe(false);
  });

  it('should handle inner port names with hyphens', () => {
    const innerTaskId = '3579x1khed4zp';
    const host = `${innerTaskId}-my-app-${suffix}.preview.roomote.run`;

    const result = parseHostWithSuffix(host, suffix);

    expect(result.isValid).toBe(true);
    expect(result.portName).toBe('my-app');
  });

  it('should return invalid for empty host', () => {
    const result = parseHostWithSuffix('', suffix);
    expect(result.isValid).toBe(false);
  });

  it('should return invalid for host without domain', () => {
    const result = parseHostWithSuffix(`inner-web-${suffix}`, suffix);
    expect(result.isValid).toBe(false);
  });
});

describe('parseHostNested', () => {
  describe('nested taskId + taskId', () => {
    it('should detect rightmost taskId as outer', () => {
      const innerTaskId = '3579x1khed4zp';
      const outerTaskId = '20imtw24sm6hv';
      const host = `${innerTaskId}-web-${outerTaskId}-preview.preview.roomote.run`;

      const result = parseHostNested(host);

      expect(result.isValid).toBe(true);
      expect(result.outerTaskId).toBe(outerTaskId);
      expect(result.outerPortName).toBe('preview');
      expect(result.innerPrefix).toBe(`${innerTaskId}-web`);
    });

    it('should handle multi-segment outer port name', () => {
      const innerTaskId = '3579x1khed4zp';
      const outerTaskId = '20imtw24sm6hv';
      const host = `${innerTaskId}-web-${outerTaskId}-my-app.preview.roomote.run`;

      const result = parseHostNested(host);

      expect(result.isValid).toBe(true);
      expect(result.outerTaskId).toBe(outerTaskId);
      expect(result.outerPortName).toBe('my-app');
      expect(result.innerPrefix).toBe(`${innerTaskId}-web`);
    });
  });

  describe('non-nested URLs', () => {
    it('should return invalid for standard taskId URL', () => {
      const host = '3579x1khed4zp-web.preview.roomote.run';

      const result = parseHostNested(host);

      expect(result.isValid).toBe(false);
    });

    it('should return invalid for empty host', () => {
      const result = parseHostNested('');
      expect(result.isValid).toBe(false);
    });

    it('should return invalid for host without domain', () => {
      const result = parseHostNested('some-subdomain');
      expect(result.isValid).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should require a port name after the outer ID', () => {
      const innerTaskId = '3579x1khed4zp';
      const outerTaskId = '20imtw24sm6hv';
      // No port name after outer ID
      const host = `${innerTaskId}-${outerTaskId}.preview.roomote.run`;

      const result = parseHostNested(host);

      expect(result.isValid).toBe(false);
    });

    it('should reject invalid port name characters', () => {
      const innerTaskId = '3579x1khed4zp';
      const outerTaskId = '20imtw24sm6hv';
      // Underscore in port name is invalid in DNS
      const host = `${innerTaskId}-web-${outerTaskId}-my_port.preview.roomote.run`;

      const result = parseHostNested(host);

      expect(result.isValid).toBe(false);
    });
  });
});

describe('stripSuffixFromHost', () => {
  const outerTaskId = '20imtw24sm6hv';
  const suffix = `${outerTaskId}-preview`;

  it('should strip suffix from subdomain', () => {
    const innerTaskId = '3579x1khed4zp';
    const host = `${innerTaskId}-web-${suffix}.preview.roomote.run`;

    const result = stripSuffixFromHost(host, suffix);

    expect(result).toBe(`${innerTaskId}-web.preview.roomote.run`);
  });

  it('should return original host when suffix is not present', () => {
    const innerTaskId = '3579x1khed4zp';
    const host = `${innerTaskId}-web.preview.roomote.run`;

    const result = stripSuffixFromHost(host, suffix);

    expect(result).toBe(host);
  });

  it('should return original host when no domain (no dot)', () => {
    const result = stripSuffixFromHost('some-subdomain', suffix);

    expect(result).toBe('some-subdomain');
  });
});

describe('parseHostForConfig', () => {
  it('should delegate to parseHost when no suffix is provided', () => {
    const host = '20imtw24sm6hv-web.preview.roomote.run';

    const result = parseHostForConfig(host);

    expect(result.isValid).toBe(true);
    expect(result.portName).toBe('web');
  });

  it('should delegate to parseHostWithSuffix when suffix is provided', () => {
    const outerTaskId = '20imtw24sm6hv';
    const suffix = `${outerTaskId}-preview`;
    const innerTaskId = '3579x1khed4zp';
    const host = `${innerTaskId}-web-${suffix}.preview.roomote.run`;

    const result = parseHostForConfig(host, suffix);

    expect(result.isValid).toBe(true);
    expect(result.taskId).toBe(innerTaskId);
    expect(result.portName).toBe('web');
  });

  it('should return invalid when suffix is provided but not found', () => {
    const host = '20imtw24sm6hv-web.preview.roomote.run';

    const result = parseHostForConfig(host, 'nonexistent-suffix');

    expect(result.isValid).toBe(false);
  });
});
