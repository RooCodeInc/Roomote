import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { EnvironmentConfig } from '@roomote/types';

import { EnvironmentPreviewContent } from './EnvironmentPreview';
import { VisualEnvironmentEditor } from './VisualEnvironmentEditor';
import { configToYaml } from './yaml-utils';
import { YamlEnvironmentEditor } from './YamlEnvironmentEditor';

vi.mock('@/hooks/source-control', () => ({
  useRepositories: () => ({
    data: [
      { id: 'repo-1', fullName: 'acme/api' },
      { id: 'repo-2', fullName: 'acme/web' },
    ],
    isPending: false,
  }),
}));

const initialConfig: EnvironmentConfig = {
  name: 'Roomote App',
  description: 'Sandbox stack',
  repositories: [
    {
      repository: 'acme/api',
      branch: 'main',
      commands: [
        {
          name: 'Install',
          run: 'pnpm install',
          timeout: 600,
          continue_on_error: false,
        },
      ],
    },
  ],
  services: ['redis7'],
  env: {
    API_KEY: 'secret',
  },
};

describe('YamlEnvironmentEditor', () => {
  it('shows the visual editor tab for edit mode and saves editor changes', async () => {
    const onSave = vi.fn().mockResolvedValue({ success: true });

    render(
      <YamlEnvironmentEditor
        mode="edit"
        initialConfig={initialConfig}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole('tab', { name: /Editor/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Yaml/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Preview/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Name$/i), {
      target: { value: 'Edited Roomote App' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Edited Roomote App',
        }),
      );
    });
  });

  it('keeps create mode on yaml and omits the visual editor tab', () => {
    render(
      <YamlEnvironmentEditor
        mode="create"
        initialConfig={initialConfig}
        onSave={vi.fn().mockResolvedValue({ success: true })}
        onCancel={() => {}}
      />,
    );

    expect(
      screen.queryByRole('tab', { name: /Editor/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Yaml/i })).toBeInTheDocument();
  });

  it('replaces user-edited content when a historical YAML version is loaded', async () => {
    const currentConfig: EnvironmentConfig = {
      name: 'Current Environment',
      description: 'Current description',
      repositories: [{ repository: 'acme/current' }],
    };
    const historicalConfig: EnvironmentConfig = {
      name: 'Historical Environment',
      description: 'Historical description',
      repositories: [{ repository: 'acme/historical' }],
    };
    const onSave = vi.fn().mockResolvedValue({ success: true });

    const { rerender } = render(
      <YamlEnvironmentEditor
        mode="edit"
        initialConfig={currentConfig}
        initialYamlContent={configToYaml(currentConfig)}
        onSave={onSave}
        onCancel={() => {}}
        activeTab="yaml"
        onActiveTabChange={() => {}}
      />,
    );

    const textarea = await screen.findByPlaceholderText(
      /Enter environment configuration in YAML format/i,
    );
    fireEvent.change(textarea, {
      target: {
        value: configToYaml({ ...currentConfig, name: 'Edited Name' }),
      },
    });

    rerender(
      <YamlEnvironmentEditor
        mode="edit"
        initialConfig={currentConfig}
        initialYamlContent={configToYaml(historicalConfig)}
        onSave={onSave}
        onCancel={() => {}}
        activeTab="yaml"
        onActiveTabChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(textarea).toHaveValue(configToYaml(historicalConfig));
    });

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(historicalConfig);
    });
  });
});

describe('VisualEnvironmentEditor', () => {
  it('preserves intentionally empty environment variable values', () => {
    const onChange = vi.fn();

    render(
      <VisualEnvironmentEditor
        config={{
          name: 'Env',
          repositories: [{ repository: 'acme/api' }],
          env: { EMPTY_VALUE: 'temporary' },
        }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('temporary'), {
      target: { value: '' },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { EMPTY_VALUE: '' },
      }),
    );
  });

  it('labels the environment variables CTA clearly', () => {
    render(
      <VisualEnvironmentEditor
        config={{
          name: 'Env',
          env: { API_KEY: '' },
          repositories: [{ repository: 'acme/api' }],
        }}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: /Add environment variable/i }),
    ).toBeInTheDocument();
  });

  it('keeps environment variable rows full width while expanding the focused input', () => {
    render(
      <VisualEnvironmentEditor
        config={{
          name: 'Env',
          env: { API_KEY: 'secret' },
          repositories: [{ repository: 'acme/api' }],
        }}
        onChange={vi.fn()}
      />,
    );

    const keyInput = screen.getByDisplayValue('API_KEY');
    const valueInput = screen.getByDisplayValue('secret');
    const removeButton = screen.getByRole('button', {
      name: /Remove API_KEY/i,
    });
    const row = keyInput.parentElement;

    expect(row).toHaveStyle({
      '--row-grid-columns': 'minmax(0, 1fr) minmax(0, 1fr) auto',
      '--row-width': '100%',
    });

    fireEvent.focus(keyInput);

    expect(row).toHaveStyle({
      '--row-grid-columns': 'minmax(0, 3fr) minmax(0, 1fr) auto',
      '--row-width': '100%',
    });

    fireEvent.focus(valueInput);

    expect(row).toHaveStyle({
      '--row-grid-columns': 'minmax(0, 1fr) minmax(0, 3fr) auto',
      '--row-width': '100%',
    });

    fireEvent.blur(valueInput, { relatedTarget: removeButton });

    expect(row).toHaveStyle({
      '--row-grid-columns': 'minmax(0, 1fr) minmax(0, 1fr) auto',
      '--row-width': '100%',
    });
  });

  it('preserves a trailing space while typing in the description field', () => {
    const onChange = vi.fn();

    render(
      <VisualEnvironmentEditor
        config={{
          name: 'Env',
          description: 'GTM',
          repositories: [{ repository: 'acme/api' }],
        }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Description$/i), {
      target: { value: 'GTM ' },
    });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description: 'GTM ',
      }),
    );
  });

  it('preserves a trailing space while typing in agent instructions', () => {
    const onChange = vi.fn();

    render(
      <VisualEnvironmentEditor
        config={{
          name: 'Env',
          agentInstructions: 'Keep',
          repositories: [{ repository: 'acme/api' }],
        }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('Keep'), {
      target: { value: 'Keep ' },
    });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentInstructions: 'Keep ',
      }),
    );
  });

  it('does not render the badge-only advanced section', () => {
    render(
      <VisualEnvironmentEditor
        config={{
          name: 'Env',
          repositories: [{ repository: 'acme/api' }],
          skills: {
            'vercel-labs/agent-skills': ['lint'],
          },
        }}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole('button', { name: /^Advanced$/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/^1 skills$/i)).not.toBeInTheDocument();
  });

  it('restores object-form service options when toggled off and back on', () => {
    const onChange = vi.fn();
    const initialEditorConfig: EnvironmentConfig = {
      name: 'Env',
      repositories: [{ repository: 'acme/api' }],
      services: [{ name: 'postgres16', port: 5433 }],
    };

    const { rerender } = render(
      <VisualEnvironmentEditor
        config={initialEditorConfig}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('PostgreSQL'));
    const configAfterToggleOff = onChange.mock.calls.at(-1)?.[0];
    expect(configAfterToggleOff.services).toBeUndefined();

    rerender(
      <VisualEnvironmentEditor
        config={configAfterToggleOff}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('PostgreSQL'));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        services: [{ name: 'postgres16', port: 5433 }],
      }),
    );
  });

  it('shows the Exposed Ports heading', () => {
    render(
      <YamlEnvironmentEditor
        mode="edit"
        initialConfig={{
          name: 'Env',
          repositories: [{ repository: 'acme/api' }],
          ports: [{ name: 'WEB', port: 3000 }],
        }}
        onSave={vi.fn().mockResolvedValue({ success: true })}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText('Exposed Ports')).toBeInTheDocument();
  });
});

describe('EnvironmentPreviewContent', () => {
  it('masks literal environment values while showing interpolations', () => {
    render(
      <EnvironmentPreviewContent
        config={{
          name: 'Env',
          repositories: [{ repository: 'acme/api' }],
          env: {
            FROM_ORG: '${SOME_VAR}',
            BARE_ORG: '$DATABASE_URL',
            SECRET_VALUE: 'hunter2',
          },
        }}
      />,
    );

    expect(screen.getByText('${SOME_VAR}')).toBeInTheDocument();
    expect(screen.getByText('$DATABASE_URL')).toBeInTheDocument();
    expect(screen.queryByText('hunter2')).not.toBeInTheDocument();
    expect(screen.getByText('•••••••')).toBeInTheDocument();
  });
});
