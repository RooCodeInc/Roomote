import {
  serviceNameSchema,
  serviceConfigSchema,
  serviceDefaultPorts,
  type ServiceName,
} from '../environment-config';

describe('Service Schema', () => {
  describe('serviceNameSchema', () => {
    it('accepts valid service names', () => {
      const validNames: ServiceName[] = [
        'redis6',
        'redis7',
        'postgres15',
        'postgres16',
        'mysql8',
        'mariadb10',
      ];

      for (const name of validNames) {
        expect(serviceNameSchema.parse(name)).toBe(name);
      }
    });

    it('rejects invalid service names', () => {
      const invalidNames = ['redis', 'postgres', 'mysql', 'redis5', 'mongodb'];

      for (const name of invalidNames) {
        expect(() => serviceNameSchema.parse(name)).toThrow();
      }
    });
  });

  describe('serviceConfigSchema', () => {
    it('accepts simple string format', () => {
      expect(serviceConfigSchema.parse('redis6')).toBe('redis6');
      expect(serviceConfigSchema.parse('postgres15')).toBe('postgres15');
    });

    it('accepts object format with just name', () => {
      const result = serviceConfigSchema.parse({ name: 'redis7' });
      expect(result).toEqual({ name: 'redis7' });
    });

    it('accepts object format with name and port', () => {
      const result = serviceConfigSchema.parse({
        name: 'postgres16',
        port: 5433,
      });
      expect(result).toEqual({ name: 'postgres16', port: 5433 });
    });

    it('rejects invalid port values', () => {
      expect(() =>
        serviceConfigSchema.parse({ name: 'redis6', port: -1 }),
      ).toThrow();
      expect(() =>
        serviceConfigSchema.parse({ name: 'redis6', port: 0 }),
      ).toThrow();
      expect(() =>
        serviceConfigSchema.parse({ name: 'redis6', port: 1.5 }),
      ).toThrow();
    });
  });

  describe('serviceDefaultPorts', () => {
    it('has correct default ports', () => {
      expect(serviceDefaultPorts.redis6).toBe(6379);
      expect(serviceDefaultPorts.redis7).toBe(6379);
      expect(serviceDefaultPorts.postgres15).toBe(5432);
      expect(serviceDefaultPorts.postgres16).toBe(5432);
      expect(serviceDefaultPorts.postgres17).toBe(5432);
      expect(serviceDefaultPorts.mysql8).toBe(3306);
      expect(serviceDefaultPorts.mariadb10).toBe(3306);
      expect(serviceDefaultPorts.clickhouse).toBe(9000);
      expect(serviceDefaultPorts.codeserver).toBe(0);
      expect(serviceDefaultPorts.aws).toBe(0);
    });
  });
});
