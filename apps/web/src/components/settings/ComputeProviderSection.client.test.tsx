import { render, screen } from '@testing-library/react';
import type {
  SetupComputeStatus,
  SetupNewComputeProvisioningState,
} from '@roomote/types';

import { ComputeProviderSection } from './ComputeProviderSection';

type ComputeProviderStatus = SetupComputeStatus['providers'][number];

const apiKeyField: ComputeProviderStatus['fields'][number] = {
  envVarName: 'E2B_API_KEY',
  label: 'E2B API Key',
  secret: true,
  category: 'credential',
  runtimeSatisfied: false,
  savedSatisfied: true,
  defaultSatisfied: false,
  setupProvisionable: false,
};

const templateField: ComputeProviderStatus['fields'][number] = {
  envVarName: 'E2B_TEMPLATE_ID',
  label: 'Worker Template ID',
  category: 'infrastructure',
  runtimeSatisfied: false,
  savedSatisfied: false,
  defaultSatisfied: false,
  setupProvisionable: true,
};

const provider: ComputeProviderStatus = {
  provider: 'e2b',
  label: 'E2B',
  description: 'Hosted E2B sandboxes.',
  supportsSnapshots: true,
  fields: [apiKeyField, templateField],
  runtimeConfigSatisfied: false,
  savedConfigSatisfied: true,
  configSatisfied: false,
  infrastructureSatisfied: true,
};

function buildProvisioning(
  overrides: Partial<SetupNewComputeProvisioningState>,
): SetupNewComputeProvisioningState {
  return {
    status: 'building',
    imageRef: 'ghcr.io/roocodeinc/roomote-worker:develop-abc12345',
    templateRef: 'roomote-worker:develop-abc12345',
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

function renderSection(provisioning: SetupNewComputeProvisioningState | null) {
  return render(
    <ComputeProviderSection
      provider={provider}
      isDefault={false}
      provisioning={provisioning}
      onSave={vi.fn()}
      onClear={vi.fn()}
      savePending={false}
      clearPending={false}
    />,
  );
}

describe('ComputeProviderSection provisioning states', () => {
  it('labels the action button Provisioning... and explains the wait while a run is building', () => {
    renderSection(buildProvisioning({ status: 'building' }));

    const button = screen.getByRole('button', { name: /Provisioning\.\.\./ });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(/Provisioning the worker base image/),
    ).toBeInTheDocument();
  });

  it('surfaces the provisioning error and offers a retry after a failed run', () => {
    renderSection(
      buildProvisioning({
        status: 'failed',
        error: 'Access denied',
        finishedAt: new Date().toISOString(),
      }),
    );

    expect(
      screen.getByText('Provisioning failed: Access denied'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Retry provisioning/ }),
    ).toBeEnabled();
  });

  it('falls back to generic failure copy when the run recorded no error', () => {
    renderSection(
      buildProvisioning({
        status: 'failed',
        finishedAt: new Date().toISOString(),
      }),
    );

    expect(
      screen.getByText('Provisioning failed. Save to retry.'),
    ).toBeInTheDocument();
  });

  it('shows the plain Save action when no provisioning run is tracked', () => {
    renderSection(null);

    expect(screen.getByRole('button', { name: /Save/ })).toBeInTheDocument();
    expect(screen.queryByText(/Provisioning failed/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Provisioning the worker base image/),
    ).not.toBeInTheDocument();
  });
});
