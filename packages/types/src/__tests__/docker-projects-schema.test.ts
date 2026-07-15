import { describe, expect, it } from 'vitest';

import { environmentConfigSchema } from '../environment-config';

const baseConfig = {
  name: 'Container environment',
  repositories: [{ repository: 'acme/app' }],
  ports: [{ name: 'WEB', port: 3000 }],
};

describe('Docker project environment schema', () => {
  it('accepts a Compose project tied to a configured repository and port', () => {
    const result = environmentConfigSchema.safeParse({
      ...baseConfig,
      docker_projects: [
        {
          type: 'compose',
          name: 'development',
          repository: 'acme/app',
          files: ['compose.yaml', 'compose.local.yaml'],
          profiles: ['agent'],
          ports: [{ named_port: 'WEB', service: 'web', container_port: 3000 }],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a Dockerfile project', () => {
    const result = environmentConfigSchema.safeParse({
      ...baseConfig,
      docker_projects: [
        {
          type: 'dockerfile',
          name: 'api',
          repository: 'acme/app',
          context: 'services/api',
          dockerfile: 'services/api/Dockerfile.dev',
          build_args: { NODE_ENV: 'development' },
          ports: [{ named_port: 'WEB', container_port: 3000 }],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects repositories, named ports, and paths outside the environment', () => {
    const result = environmentConfigSchema.safeParse({
      ...baseConfig,
      docker_projects: [
        {
          type: 'compose',
          name: 'development',
          repository: 'acme/other',
          files: ['../compose.yaml'],
          ports: [
            { named_port: 'MISSING', service: 'web', container_port: 3000 },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toContain('Path must stay within the selected repository');
    expect(messages).toContain(
      "Docker project repository 'acme/other' is not configured in this environment",
    );
    expect(messages).toContain(
      "Docker project port 'MISSING' is not configured in the environment ports list",
    );
  });

  it('requires Compose port mappings to name a service', () => {
    const result = environmentConfigSchema.safeParse({
      ...baseConfig,
      docker_projects: [
        {
          type: 'compose',
          name: 'development',
          repository: 'acme/app',
          files: ['compose.yaml'],
          ports: [{ named_port: 'WEB', container_port: 3000 }],
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'Compose port mappings require a service name',
    );
  });

  it('requires unique project names and named port ownership', () => {
    const result = environmentConfigSchema.safeParse({
      ...baseConfig,
      docker_projects: [
        {
          type: 'dockerfile',
          name: 'api',
          repository: 'acme/app',
          ports: [{ named_port: 'WEB', container_port: 3000 }],
        },
        {
          type: 'dockerfile',
          name: 'API',
          repository: 'acme/app',
          ports: [{ named_port: 'web', container_port: 3001 }],
        },
      ],
    });

    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toContain('Duplicate Docker project name: API');
    expect(messages).toContain(
      "Environment port 'web' can only be mapped by one Docker project",
    );
  });
});
