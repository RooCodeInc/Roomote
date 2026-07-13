import { fireEvent, render, screen } from '@testing-library/react';

import { ContainerProjectListEditor } from './ContainerProjectListEditor';

describe('ContainerProjectListEditor', () => {
  it('adds a Compose project tied to the first configured repository', () => {
    const onChange = vi.fn();
    render(
      <ContainerProjectListEditor
        repositories={[{ repository: 'acme/web' }]}
        ports={[{ name: 'WEB', port: 3000 }]}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Add container project/i }),
    );

    expect(onChange).toHaveBeenCalledWith([
      {
        type: 'compose',
        name: 'app1',
        repository: 'acme/web',
        files: ['compose.yaml'],
        required: true,
      },
    ]);
  });

  it('adds a named preview mapping for a Dockerfile', () => {
    const onChange = vi.fn();
    render(
      <ContainerProjectListEditor
        projects={[
          {
            type: 'dockerfile',
            name: 'web',
            repository: 'acme/web',
          },
        ]}
        repositories={[{ repository: 'acme/web' }]}
        ports={[{ name: 'WEB', port: 3000 }]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Map preview port/i }));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'dockerfile',
        ports: [
          {
            named_port: 'WEB',
            container_port: 3000,
          },
        ],
      }),
    ]);
  });
});
