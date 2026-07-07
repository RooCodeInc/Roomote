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
