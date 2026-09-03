// pnpm --filter @roomote/types test src/__tests__/command-schema.test.ts

import YAML from 'yaml';

import {
  commandSchema,
  environmentConfigSchema,
  environmentRepositoryConfigSchema,
  getDuplicateEnvironmentRepositoryConfigError,
  getMissingEnvironmentRepositoryError,
} from '../environment-config';
import { workspaceRoutingSettingsSchema } from '../workspace-routing';

describe('workspaceRoutingSettingsSchema', () => {
  it('normalizes centralized routing rules', () => {
    expect(
      workspaceRoutingSettingsSchema.parse({
        rules: [
          {
            description: '  Messages from hospital-bugs belong here.  ',
            target: 'env-1',
          },
        ],
      }),
    ).toEqual({
      rules: [
        {
          description: 'Messages from hospital-bugs belong here.',
          target: 'env-1',
        },
      ],
    });
  });

  it('rejects empty descriptions and targets', () => {
    expect(
      workspaceRoutingSettingsSchema.safeParse({
        rules: [{ description: ' ', target: '' }],
      }).success,
    ).toBe(false);
  });
});

describe('getMissingEnvironmentRepositoryError', () => {
  it('reports configured repositories that do not exactly match linked rows', () => {
    expect(
      getMissingEnvironmentRepositoryError(
        ['roomote/Test ADO', 'roomote/Test ADO/Test ADO'],
        [{ fullName: 'roomote/Test ADO/Test ADO' }],
      ),
    ).toBe('Repositories are not linked to this deployment: roomote/Test ADO');
  });

  it('returns null when every configured repository is linked', () => {
    expect(
      getMissingEnvironmentRepositoryError(
        ['roomote/Test ADO/Test ADO'],
        [{ fullName: 'roomote/Test ADO/Test ADO' }],
      ),
    ).toBeNull();
  });
});

describe('commandSchema', () => {
  describe('YAML block scalar support', () => {
    it('should accept a YAML | (literal block scalar) multi-line run value', () => {
      // YAML `|` preserves newlines and adds a trailing newline.
      const yamlInput = `
name: Setup
run: |
  npm install
  npm run build
timeout: 300
`;
      const parsed = YAML.parse(yamlInput);
      const result = commandSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.run).toBe('npm install\nnpm run build\n');
        expect(result.data.name).toBe('Setup');
      }
    });

    it('should accept a YAML |- (strip trailing newline) multi-line run value', () => {
      // YAML `|-` preserves newlines but strips the trailing newline.
      const yamlInput = `
name: Test
run: |-
  ls /foo
  ls /bar
`;
      const parsed = YAML.parse(yamlInput);
      const result = commandSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.run).toBe('ls /foo\nls /bar');
      }
    });

    it('should accept a YAML |+ (keep all trailing newlines) multi-line run value', () => {
      // YAML `|+` preserves all trailing newlines.
      const yamlInput = `
name: Test
run: |+
  echo hello
  echo world

`;
      const parsed = YAML.parse(yamlInput);
      const result = commandSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.run).toBe('echo hello\necho world\n\n');
      }
    });

    it('should accept a single-line run value', () => {
      const yamlInput = `
name: Quick
run: echo hello
`;
      const parsed = YAML.parse(yamlInput);
      const result = commandSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.run).toBe('echo hello');
      }
    });

    it('should reject an empty run value', () => {
      const yamlInput = `
name: Empty
run: ""
`;
      const parsed = YAML.parse(yamlInput);
      const result = commandSchema.safeParse(parsed);

      expect(result.success).toBe(false);
    });

    it('should accept run with backslash continuation lines', () => {
      const yamlInput = `
name: Continuation
run: |
  echo "hello" && \\
  echo "world"
`;
      const parsed = YAML.parse(yamlInput);
      const result = commandSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.run).toContain('\\');
        expect(result.data.run).toContain('echo "hello"');
        expect(result.data.run).toContain('echo "world"');
      }
    });

    it('should accept run with comments in the script', () => {
      const yamlInput = `
name: With comments
run: |
  # Install dependencies
  npm install
  # Build the project
  npm run build
`;
      const parsed = YAML.parse(yamlInput);
      const result = commandSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.run).toContain('# Install dependencies');
        expect(result.data.run).toContain('npm install');
      }
    });

    it('should preserve optional fields alongside multi-line run', () => {
      const yamlInput = `
name: Full config
run: |
  npm install
  npm test
timeout: 120
continue_on_error: true
env:
  NODE_ENV: test
  CI: "true"
`;
      const parsed = YAML.parse(yamlInput);
      const result = commandSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.run).toBe('npm install\nnpm test\n');
        expect(result.data.timeout).toBe(120);
        expect(result.data.continue_on_error).toBe(true);
        expect(result.data.env).toEqual({ NODE_ENV: 'test', CI: 'true' });
      }
    });

    it('should accept an optional retries field', () => {
      const yamlInput = `
name: Retryable
run: git clone https://github.com/acme/backend.git
retries: 4
`;
      const parsed = YAML.parse(yamlInput);
      const result = commandSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.retries).toBe(4);
      }
    });
  });
});

describe('environmentRepositoryConfigSchema', () => {
  describe('repository', () => {
    it('should accept an owner/repo full name', () => {
      const result = environmentRepositoryConfigSchema.safeParse({
        repository: 'myorg/backend',
      });

      expect(result.success).toBe(true);
    });

    it('should accept an Azure DevOps organization/project/repo full name with spaces', () => {
      const result = environmentRepositoryConfigSchema.safeParse({
        repository: 'roomote/Test ADO/Test ADO',
      });

      expect(result.success).toBe(true);
    });

    it('should accept a GitLab subgroup full name with more than three segments', () => {
      const result = environmentRepositoryConfigSchema.safeParse({
        repository: 'group/subgroup/team/repo',
      });

      expect(result.success).toBe(true);
    });

    it('should reject a name without a slash', () => {
      const result = environmentRepositoryConfigSchema.safeParse({
        repository: 'backend',
      });

      expect(result.success).toBe(false);
    });

    it('should reject empty segments', () => {
      for (const repository of ['owner/', '/repo', 'org//repo']) {
        const result = environmentRepositoryConfigSchema.safeParse({
          repository,
        });

        expect(result.success).toBe(false);
      }
    });
  });

  describe('tool_versions', () => {
    it('should accept a valid tool_versions record', () => {
      const result = environmentRepositoryConfigSchema.safeParse({
        repository: 'myorg/backend',
        tool_versions: { node: '20.11.0', python: '3.12.1' },
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.tool_versions).toEqual({
          node: '20.11.0',
          python: '3.12.1',
        });
      }
    });

    it('should be optional (configs without it still pass)', () => {
      const result = environmentRepositoryConfigSchema.safeParse({
        repository: 'myorg/backend',
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.tool_versions).toBeUndefined();
      }
    });

    it('should reject an empty tool name', () => {
      const result = environmentRepositoryConfigSchema.safeParse({
        repository: 'myorg/backend',
        tool_versions: { '': '20.11.0' },
      });

      expect(result.success).toBe(false);
    });

    it('should reject an empty version string', () => {
      const result = environmentRepositoryConfigSchema.safeParse({
        repository: 'myorg/backend',
        tool_versions: { node: '' },
      });

      expect(result.success).toBe(false);
    });

    it('should work alongside branch and commands', () => {
      const result = environmentRepositoryConfigSchema.safeParse({
        repository: 'myorg/backend',
        branch: 'develop',
        tool_versions: { node: '20.11.0' },
        commands: [{ name: 'Install', run: 'npm install' }],
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.branch).toBe('develop');
        expect(result.data.tool_versions).toEqual({ node: '20.11.0' });
        expect(result.data.commands).toHaveLength(1);
      }
    });

    it('should parse tool_versions correctly from YAML input', () => {
      const yamlInput = `
repository: myorg/backend
tool_versions:
  node: "20.11.0"
  python: "3.12.1"
  ruby: "3.3.0"
commands:
  - name: Install
    run: npm install
`;
      const parsed = YAML.parse(yamlInput);
      const result = environmentRepositoryConfigSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.tool_versions).toEqual({
          node: '20.11.0',
          python: '3.12.1',
          ruby: '3.3.0',
        });
      }
    });

    it('should accept an empty object for tool_versions', () => {
      const result = environmentRepositoryConfigSchema.safeParse({
        repository: 'myorg/backend',
        tool_versions: {},
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.tool_versions).toEqual({});
      }
    });
  });

  describe('YAML block scalar commands in repository config', () => {
    it('should accept repository config with multi-line commands', () => {
      // This is the exact format from the user's question.
      const yamlInput = `
repository: myorg/backend
commands:
  - name: Test command
    run: |
      ls /foo
      ls /bar
`;
      const parsed = YAML.parse(yamlInput);
      const result = environmentRepositoryConfigSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.repository).toBe('myorg/backend');
        expect(result.data.commands).toHaveLength(1);
        expect(result.data.commands![0]!.name).toBe('Test command');
        expect(result.data.commands![0]!.run).toBe('ls /foo\nls /bar\n');
      }
    });

    it('should accept repository config with multiple multi-line commands', () => {
      const yamlInput = `
repository: myorg/backend
commands:
  - name: Install
    run: |
      npm install
      npm run postinstall
  - name: Build
    run: |
      npm run build
      npm run typecheck
  - name: Start server
    run: npm start
    detached: true
    logfile: /tmp/server.log
`;
      const parsed = YAML.parse(yamlInput);
      const result = environmentRepositoryConfigSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.commands).toHaveLength(3);
        expect(result.data.commands![0]!.run).toBe(
          'npm install\nnpm run postinstall\n',
        );
        expect(result.data.commands![1]!.run).toBe(
          'npm run build\nnpm run typecheck\n',
        );
        expect(result.data.commands![2]!.run).toBe('npm start');
        expect(result.data.commands![2]!.detached).toBe(true);
      }
    });

    it('should accept repository config with branch and multi-line commands', () => {
      const yamlInput = `
repository: myorg/backend
branch: develop
commands:
  - name: Setup
    run: |
      npm install
      npm run migrate
`;
      const parsed = YAML.parse(yamlInput);
      const result = environmentRepositoryConfigSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.repository).toBe('myorg/backend');
        expect(result.data.branch).toBe('develop');
        expect(result.data.commands).toHaveLength(1);
        expect(result.data.commands![0]!.run).toBe(
          'npm install\nnpm run migrate\n',
        );
      }
    });
  });
});

describe('environmentConfigSchema', () => {
  it.each([
    {
      label: 'top-level env',
      config: {
        env: { R_SANDBOX_OPENROUTER_API_KEY: 'must-not-be-stored' },
      },
    },
    {
      label: 'repository command env',
      config: {
        repositories: [
          {
            repository: 'owner/repo',
            commands: [
              {
                name: 'start',
                run: 'pnpm dev',
                env: {
                  R_SANDBOX_OPENROUTER_API_KEY: 'must-not-be-stored',
                },
              },
            ],
          },
        ],
      },
    },
    {
      label: 'Docker project env',
      config: {
        docker_projects: [
          {
            name: 'app',
            repository: 'owner/repo',
            type: 'compose',
            files: ['compose.yml'],
            env: { R_SANDBOX_OPENROUTER_API_KEY: 'must-not-be-stored' },
          },
        ],
      },
    },
    {
      label: 'MCP process env',
      config: {
        mcpServers: {
          local: {
            command: 'node',
            env: { R_SANDBOX_OPENROUTER_API_KEY: 'must-not-be-stored' },
          },
        },
      },
    },
  ])('rejects the sandbox OpenRouter key in $label', ({ config }) => {
    const result = environmentConfigSchema.safeParse({
      name: 'Env',
      repositories: [{ repository: 'owner/repo' }],
      ...config,
    });

    expect(result.success).toBe(false);
  });

  it('keeps legacy duplicate repository entries parseable on read', () => {
    const result = environmentConfigSchema.safeParse({
      name: 'Env',
      repositories: [
        { repository: 'owner/repo' },
        { repository: 'owner/repo' },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('reports duplicate repository entries for write validation', () => {
    expect(
      getDuplicateEnvironmentRepositoryConfigError([
        { repository: 'owner/repo' },
        { repository: 'owner/repo' },
      ]),
    ).toBe('Duplicate repository: owner/repo');
    expect(
      getDuplicateEnvironmentRepositoryConfigError([
        { repository: 'owner/repo' },
        { repository: 'owner/other' },
      ]),
    ).toBeNull();
  });

  describe('tool_versions', () => {
    it('should accept root-level tool_versions for environment workspaces', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        tool_versions: { node: '22.14.0', python: '3.12.1' },
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.tool_versions).toEqual({
          node: '22.14.0',
          python: '3.12.1',
        });
      }
    });

    it('should parse root-level tool_versions correctly from YAML input', () => {
      const yamlInput = `
name: Shared Environment
tool_versions:
  node: "22.14.0"
  python: "3.12.1"
repositories:
  - repository: owner/repo
`;
      const parsed = YAML.parse(yamlInput);
      const result = environmentConfigSchema.safeParse(parsed);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.tool_versions).toEqual({
          node: '22.14.0',
          python: '3.12.1',
        });
      }
    });
  });

  it('should strip the deprecated desktop flag from environments', () => {
    const result = environmentConfigSchema.safeParse({
      name: 'Env',
      repositories: [{ repository: 'owner/repo' }],
      desktop: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect('desktop' in result.data).toBe(false);
    }
  });

  describe('initialUrl', () => {
    it('should accept an absolute URL', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        initialUrl: 'http://127.0.0.1:3000/auth/dev-login',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.initialUrl).toBe(
          'http://127.0.0.1:3000/auth/dev-login',
        );
      }
    });

    it('should accept about:blank', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        initialUrl: 'about:blank',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.initialUrl).toBe('about:blank');
      }
    });

    it('should reject a relative URL', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        initialUrl: '/auth/dev-login',
      });

      expect(result.success).toBe(false);
    });
  });

  it('accepts previews_enabled for environments', () => {
    const result = environmentConfigSchema.safeParse({
      name: 'Env',
      repositories: [{ repository: 'owner/repo' }],
      previews_enabled: false,
    });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.previews_enabled).toBe(false);
    }
  });

  describe('superRefine validations', () => {
    it('should reject reserved system port names', () => {
      for (const name of ['SANDBOX_SERVER', 'EDITOR']) {
        const result = environmentConfigSchema.safeParse({
          name: 'Env',
          repositories: [{ repository: 'owner/repo' }],
          ports: [{ name, port: 3000 }],
        });

        expect(result.success).toBe(false);

        if (!result.success) {
          const messages = result.error.issues.map((i) => i.message);
          expect(messages).toContain(
            `Port name '${name}' is reserved for Roomote system use`,
          );
        }
      }
    });

    it('drops legacy codeserver services during parsing', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        services: ['codeserver', 'postgres17'],
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.services).toEqual(['postgres17']);
      }
    });
  });

  describe('mcpServers', () => {
    it('should accept streamable-http and stdio MCP server configs', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        mcpServers: {
          docs: {
            url: 'https://mcp.example.com/docs',
            headers: {
              Authorization: 'Bearer test-token',
            },
          },
          internal: {
            command: 'npx',
            args: ['-y', '@acme/internal-mcp'],
            env: {
              INTERNAL_MCP_TOKEN: 'abc123',
            },
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it('should infer MCP server type from url or command', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        mcpServers: {
          docs: {
            url: 'https://mcp.example.com/docs',
            headers: {
              Authorization: 'Bearer test-token',
            },
          },
          internal: {
            command: 'npx',
            args: ['-y', '@acme/internal-mcp'],
            env: {
              INTERNAL_MCP_TOKEN: 'abc123',
            },
          },
        },
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.mcpServers?.docs).toEqual({
          url: 'https://mcp.example.com/docs',
          headers: {
            Authorization: 'Bearer test-token',
          },
        });
        expect(result.data.mcpServers?.internal).toEqual({
          command: 'npx',
          args: ['-y', '@acme/internal-mcp'],
          env: {
            INTERNAL_MCP_TOKEN: 'abc123',
          },
        });
      }
    });

    it('should reject streamable-http MCP server configs without url', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        mcpServers: {
          docs: {
            type: 'streamable-http',
          },
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject MCP server configs when both url and command are present', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        mcpServers: {
          custom: {
            url: 'https://mcp.example.com',
            command: 'npx',
          },
        },
      });

      expect(result.success).toBe(false);
    });

    it('should ignore explicit type in MCP server configs', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        mcpServers: {
          custom: {
            type: 'streamable-http',
            url: 'https://mcp.example.com',
          },
        },
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.mcpServers?.custom).toEqual({
          url: 'https://mcp.example.com',
        });
      }
    });
  });

  describe('skills', () => {
    it('should accept skills grouped by owner/repo', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        skills: {
          'anthropics/skills': ['frontend-design'],
          'vercel-labs/agent-skills': ['web-design-guidelines'],
        },
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.skills).toEqual({
          'anthropics/skills': ['frontend-design'],
          'vercel-labs/agent-skills': ['web-design-guidelines'],
        });
      }
    });

    it('should accept all to install every skill from a source', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        skills: {
          'dbt-labs/dbt-agent-skills': 'all',
        },
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.skills).toEqual({
          'dbt-labs/dbt-agent-skills': 'all',
        });
      }
    });

    it('should reject sources without owner/repo slash format', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        skills: {
          anthropics: ['frontend-design'],
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject skill names containing slash', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        skills: {
          'anthropics/skills': ['design/frontend'],
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject whitespace-only skill names', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        skills: {
          'anthropics/skills': ['   '],
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject unsupported string values', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        skills: {
          'dbt-labs/dbt-agent-skills': 'everything',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should accept inline manual skills in the structured array shape', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        manualSkills: [
          {
            name: 'my-manual-skill',
            description: 'Adds a custom Roomote skill.',
            content:
              '# My Manual Skill\n\nUse this skill for custom behavior.\n',
          },
        ],
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.manualSkills).toEqual([
          {
            name: 'my-manual-skill',
            description: 'Adds a custom Roomote skill.',
            content:
              '# My Manual Skill\n\nUse this skill for custom behavior.\n',
          },
        ]);
      }
    });

    it('should reject legacy manualSkills maps', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        manualSkills: {
          'my-manual-skill': `---
name: my-manual-skill
description: Adds a custom Roomote skill.
---

# My Manual Skill
`,
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject non-array manual skills values', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        manualSkills: '# Missing frontmatter',
      });

      expect(result.success).toBe(false);
    });

    it('rejects structured manual skills without content', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        manualSkills: [
          {
            name: 'my-manual-skill',
            description: 'Adds a custom Roomote skill.',
            content: '   ',
          },
        ],
      });

      expect(result.success).toBe(false);
    });

    it('rejects duplicate manual skill names within an environment', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        manualSkills: [
          {
            name: 'my-manual-skill',
            description: 'First variant.',
            content: '# First Manual Skill\n',
          },
          {
            name: 'my-manual-skill',
            description: 'Second variant.',
            content: '# Second Manual Skill\n',
          },
        ],
      });

      expect(result.success).toBe(false);
    });
  });

  describe('auth_bypass_header', () => {
    it('should accept true for auto-generated bypass value', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.auth_bypass_header).toBe(true);
      }
    });

    it('should accept a string with min 8 chars', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header: 'my-secret-value-123',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.auth_bypass_header).toBe('my-secret-value-123');
      }
    });

    it('should reject string shorter than 8 chars', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header: 'short',
      });
      expect(result.success).toBe(false);
    });

    it('should accept undefined (optional, defaults to enabled at runtime)', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.auth_bypass_header).toBeUndefined();
      }
    });

    it('should accept false to explicitly disable bypass', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.auth_bypass_header).toBe(false);
      }
    });

    it('should reject numbers', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header: 12345678,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('auth_bypass_header_name', () => {
    it('should accept a valid HTTP header name', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header_name: 'x-bypass-inner-auth',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.auth_bypass_header_name).toBe('x-bypass-inner-auth');
      }
    });

    it('should accept undefined (optional)', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.auth_bypass_header_name).toBeUndefined();
      }
    });

    it('should accept header names with RFC 7230 token characters', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header_name: "X-Custom_Header.Name!#$%&'*+^`|~",
      });
      expect(result.success).toBe(true);
    });

    it('should reject empty string', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header_name: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject header names with spaces', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header_name: 'invalid header',
      });
      expect(result.success).toBe(false);
    });

    it('should reject header names with colons', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header_name: 'invalid:header',
      });
      expect(result.success).toBe(false);
    });

    it('should reject header names longer than 128 characters', () => {
      const result = environmentConfigSchema.safeParse({
        name: 'Env',
        repositories: [{ repository: 'owner/repo' }],
        auth_bypass_header_name: 'x-' + 'a'.repeat(127),
      });
      expect(result.success).toBe(false);
    });
  });
});
