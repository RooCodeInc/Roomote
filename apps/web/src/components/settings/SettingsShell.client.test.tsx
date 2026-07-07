import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const state = vi.hoisted(() => ({
  isAdmin: true,
  pushMock: vi.fn(),
}));

function Icon() {
  return <svg aria-hidden="true" />;
}

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: state.pushMock }),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    isAdmin: state.isAdmin,
    featureFlags: {},
  }),
}));

vi.mock('@/components/system', async () => {
  const actual = await vi.importActual<typeof import('@/components/system')>(
    '@/components/system',
  );

  return {
    ...actual,
    Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    AlertCircle: Icon,
    AlertDescription: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    CreditCardIcon: Icon,
    VectorSquare: Icon,
    IdCard: Icon,
    Label: ({ children }: { children: ReactNode }) => <label>{children}</label>,
    PlugIcon: Icon,
    GraduationCap: Icon,
    Rainbow: Icon,
    ScrollText: Icon,
    Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SelectTrigger: ({ children }: { children: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    SelectValue: () => <span>value</span>,
    Zap: Icon,
  };
});

import { SettingsShell } from './SettingsShell';

describe('SettingsShell', () => {
  beforeEach(() => {
    state.isAdmin = true;
    state.pushMock.mockReset();
  });

  it('shows all settings destinations and the integrations subtitle for admins', () => {
    render(
      <SettingsShell pageId="integrations" adminOnly={true}>
        <div>content</div>
      </SettingsShell>,
    );

    expect(screen.getByRole('link', { name: /personal/i })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /environments/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /live previews/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /agent guidance/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /integrations/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /users/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /skills/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /vibes/i })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Enable deployment integrations. Individual users can optionally link their own accounts when an integration supports it.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('places agent guidance before skills in the admin settings rail', () => {
    render(
      <SettingsShell pageId="agent-guidance" adminOnly={true}>
        <div>content</div>
      </SettingsShell>,
    );

    const guidanceLink = screen.getByRole('link', { name: /agent guidance/i });
    const skillsLink = screen.getByRole('link', { name: /skills/i });

    expect(guidanceLink.compareDocumentPosition(skillsLink)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('places live previews after environments in the admin settings rail', () => {
    render(
      <SettingsShell pageId="previews" adminOnly={true}>
        <div>content</div>
      </SettingsShell>,
    );

    const environmentsLink = screen.getByRole('link', {
      name: /environments/i,
    });
    const previewsLink = screen.getByRole('link', {
      name: /live previews/i,
    });

    expect(environmentsLink.compareDocumentPosition(previewsLink)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      screen.getByText('Enable live previews of the results of Roomote tasks.'),
    ).toBeInTheDocument();
  });

  it('places users after skills in the admin settings rail', () => {
    render(
      <SettingsShell pageId="users" adminOnly={true}>
        <div>content</div>
      </SettingsShell>,
    );

    const skillsLink = screen.getByRole('link', { name: /skills/i });
    const usersLink = screen.getByRole('link', { name: /users/i });

    expect(skillsLink.compareDocumentPosition(usersLink)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('shows skills for admins without feature-flag gating', () => {
    render(
      <SettingsShell pageId="integrations" adminOnly={true}>
        <div>content</div>
      </SettingsShell>,
    );

    expect(screen.getByRole('link', { name: /skills/i })).toBeInTheDocument();
  });

  it('limits non-admin tokens to personal settings and blocks admin-only content without redirecting', () => {
    state.isAdmin = false;

    render(
      <SettingsShell pageId="integrations" adminOnly={true}>
        <div>content</div>
      </SettingsShell>,
    );

    expect(screen.getByRole('link', { name: /personal/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /environments/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /live previews/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Only admins can access this settings page.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });
});
