import YAML from 'yaml';

import type { EnvironmentConfig } from '@roomote/types';

import { configToYaml } from './yaml-utils';

describe('configToYaml', () => {
  it('omits the deprecated desktop flag when serializing environment config', () => {
    const config: EnvironmentConfig = {
      name: 'Desktop Env',
      repositories: [{ repository: 'Roomote/example-app' }],
    };

    const yaml = configToYaml(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.desktop).toBeUndefined();
    expect(yaml).not.toContain('desktop: true');
  });

  it('preserves initialUrl when serializing environment config', () => {
    const config: EnvironmentConfig = {
      name: 'Browser Env',
      initialUrl: 'http://127.0.0.1:3000/auth/dev-login',
      repositories: [{ repository: 'Roomote/example-app' }],
    };

    const yaml = configToYaml(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.initialUrl).toBe('http://127.0.0.1:3000/auth/dev-login');
    expect(yaml).toContain('initialUrl: http://127.0.0.1:3000/auth/dev-login');
  });

  it('preserves named preview ports when serializing environment config', () => {
    const config: EnvironmentConfig = {
      name: 'Preview Env',
      repositories: [{ repository: 'Roomote/example-app' }],
      ports: [
        {
          name: 'WEBAPP',
          port: 3000,
          primary: true,
          initial_path: '/auth/dev-login',
        },
      ],
    };

    const yaml = configToYaml(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.ports).toEqual([
      {
        name: 'WEBAPP',
        port: 3000,
        primary: true,
        initial_path: '/auth/dev-login',
      },
    ]);
    expect(yaml).toContain('ports:');
  });

  it('preserves root-level tool_versions when serializing environment config', () => {
    const config: EnvironmentConfig = {
      name: 'Shared Toolchain Env',
      repositories: [{ repository: 'Roomote/example-app' }],
      tool_versions: {
        node: '22.14.0',
        python: '3.12.1',
      },
    };

    const yaml = configToYaml(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.tool_versions).toEqual({
      node: '22.14.0',
      python: '3.12.1',
    });
    expect(yaml).toContain('tool_versions:');
  });

  it('preserves docker projects when serializing environment config', () => {
    const config: EnvironmentConfig = {
      name: 'Docker Projects Env',
      repositories: [{ repository: 'Roomote/example-app' }],
      ports: [
        {
          name: 'WEBAPP',
          port: 3000,
        },
      ],
      docker_projects: [
        {
          name: 'compose-app',
          type: 'compose',
          repository: 'Roomote/example-app',
          working_dir: 'deploy',
          files: ['compose.yaml', 'compose.override.yaml'],
          profiles: ['development'],
          services: ['web'],
          env: { NODE_ENV: 'development' },
          ports: [
            {
              named_port: 'WEBAPP',
              service: 'web',
              container_port: 3000,
            },
          ],
          required: true,
          startup_timeout_seconds: 120,
        },
        {
          name: 'worker-image',
          type: 'dockerfile',
          repository: 'Roomote/example-app',
          context: '.',
          dockerfile: 'Dockerfile.worker',
          target: 'development',
          build_args: { NODE_VERSION: '22' },
          command: ['pnpm', 'worker'],
        },
      ],
    };

    const yaml = configToYaml(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.docker_projects).toEqual(config.docker_projects);
    expect(yaml).toContain('docker_projects:');
  });

  it('preserves manualSkills when serializing environment config', () => {
    const config: EnvironmentConfig = {
      name: 'Manual Skills Env',
      repositories: [{ repository: 'Roomote/example-app' }],
      manualSkills: [
        {
          name: 'my-manual-skill',
          description: 'Adds custom Roomote behavior.',
          content: '# My Manual Skill\n',
        },
      ],
    };

    const yaml = configToYaml(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.manualSkills).toEqual([
      {
        name: 'my-manual-skill',
        description: 'Adds custom Roomote behavior.',
        content: '# My Manual Skill\n',
      },
    ]);
    expect(yaml).toContain('manualSkills:');
  });

  it('preserves OIDC targets when serializing environment config', () => {
    const config: EnvironmentConfig = {
      name: 'OIDC Env',
      repositories: [{ repository: 'Roomote/example-app' }],
      oidc: {
        aws: {
          audience: 'sts.amazonaws.com',
          token_file: '/home/roomote/.roomote/oidc/aws/token',
          region: 'us-east-1',
          role_arn: 'arn:aws:iam::123456789012:role/example',
        },
        custom: [
          {
            audience: 'custom-audience',
            token_file: '/home/roomote/.roomote/oidc/custom/token',
          },
        ],
      },
    };

    const yaml = configToYaml(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.oidc).toEqual({
      aws: {
        audience: 'sts.amazonaws.com',
        token_file: '/home/roomote/.roomote/oidc/aws/token',
        region: 'us-east-1',
        role_arn: 'arn:aws:iam::123456789012:role/example',
      },
      custom: [
        {
          audience: 'custom-audience',
          token_file: '/home/roomote/.roomote/oidc/custom/token',
        },
      ],
    });
    expect(yaml).toContain('oidc:');
  });
});
