import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('step=auth-provider'),
}));

import { SetupDocs } from './SetupDocs';
import { getSetupDocsPath, getSetupDocsStep } from './setup-docs';

describe('SetupDocs', () => {
  it('maps setup steps to the matching documentation pages', () => {
    expect(getSetupDocsPath('auth-provider')).toBe('communications');
    expect(
      getSetupDocsPath('auth-env-vars', { authProvider: 'microsoft' }),
    ).toBe('providers/communications/microsoft-teams');
    expect(getSetupDocsPath('slack', { authProvider: 'microsoft' })).toBe(
      'providers/communications/microsoft-teams',
    );
    expect(
      getSetupDocsPath('source-control-connect', {
        sourceControlProvider: 'github',
      }),
    ).toBe('providers/source-control/github');
    expect(getSetupDocsPath('compute-config', { computeProvider: 'e2b' })).toBe(
      'providers/compute/e2b',
    );
    expect(getSetupDocsPath('compute-config', { computeProvider: 'box' })).toBe(
      'providers/compute/box',
    );
    expect(getSetupDocsPath('env-vars', { modelProvider: 'vllm' })).toBe(
      'providers/inference/vllm',
    );
    expect(getSetupDocsPath('repo-selection')).toBe('environments');
    expect(getSetupDocsPath('welcome')).toBeNull();
    expect(getSetupDocsStep('email-account')).toBe('email-account');
    expect(getSetupDocsStep(null)).toBe('welcome');
  });

  it.each([
    ['amazon-bedrock', 'amazon-bedrock'],
    ['anthropic', 'anthropic'],
    ['azure', 'azure-openai'],
    ['azure-cognitive-services', 'azure-foundry'],
    ['baseten', 'baseten'],
    ['chatgpt', 'chatgpt'],
    ['cloudflare-ai-gateway', 'cloudflare-ai-gateway'],
    ['cloudflare-workers-ai', 'cloudflare-workers-ai'],
    ['github-copilot', 'github-copilot'],
    ['google', 'google-gemini'],
    ['kimi-for-coding', 'kimi-for-coding'],
    ['litellm', 'litellm'],
    ['minimax', 'minimax'],
    ['moonshotai', 'moonshot-ai'],
    ['ollama', 'ollama'],
    ['openai', 'openai'],
    ['openai-compatible', 'openai-compatible'],
    ['opencode', 'opencode'],
    ['opencode-go', 'opencode-go'],
    ['openrouter', 'openrouter'],
    ['requesty', 'requesty'],
    ['togetherai', 'together-ai'],
    ['vercel', 'vercel-ai-gateway'],
    ['vllm', 'vllm'],
    ['xai', 'xai'],
    ['xai-subscription', 'xai-subscription'],
    ['zai', 'zai'],
    ['zai-coding-plan', 'zai-coding-plan'],
  ])(
    'shows the %s guide for the selected inference provider',
    (provider, slug) => {
      expect(getSetupDocsPath('env-vars', { modelProvider: provider })).toBe(
        `providers/inference/${slug}`,
      );
    },
  );

  it('opens and closes the desktop documentation frame', () => {
    function SetupDocsHarness() {
      const [isOpen, setIsOpen] = useState(false);

      return (
        <SetupDocs isOpen={isOpen} onOpenChange={setIsOpen}>
          <p>Docs content</p>
        </SetupDocs>
      );
    }

    render(<SetupDocsHarness />);

    expect(screen.queryByText('Docs content')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Need help? Docs are here' }),
    );

    expect(screen.getByText('Docs content')).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: 'Open this documentation page in a new tab',
      }),
    ).toHaveAttribute('href', 'https://docs.roomote.dev/communications');

    fireEvent.click(screen.getByRole('button', { name: 'Close docs' }));

    expect(screen.queryByText('Docs content')).not.toBeInTheDocument();
  });
});
