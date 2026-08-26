import { render, screen } from '@testing-library/react';

import { WorkspaceHeader } from './WorkspaceHeader';
import { WorkspaceSurface } from './WorkspaceSurface';

describe('Workspace detail layout', () => {
  it('keeps workspace content and side actions in the shared task surface', () => {
    render(
      <WorkspaceSurface sideActions={<aside>Actions</aside>}>
        <div>Workspace content</div>
      </WorkspaceSurface>,
    );

    expect(screen.getByText('Workspace content')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('renders arbitrary task or session header content in the shared header', () => {
    render(
      <WorkspaceHeader>
        <h1>Conversation title</h1>
        <span>Context</span>
      </WorkspaceHeader>,
    );

    expect(
      screen.getByRole('heading', { name: 'Conversation title' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Context')).toBeInTheDocument();
  });
});
