import { fireEvent, render, screen } from '@testing-library/react';
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
    runtimeSchemaVersion: 2,
    imageRef: 'ghcr.io/roocodeinc/roomote-worker:develop-abc12345',
    templateRef: 'roomote-worker:develop-abc12345',
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

function renderSection(
  provisioning: SetupNewComputeProvisioningState | null,
  providerOverride: ComputeProviderStatus = provider,
) {
  return render(
    <ComputeProviderSection
      provider={providerOverride}
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
      screen.getByText(/must finish before this provider can run tasks/),
    ).toBeInTheDocument();
  });

  it('explains that a rebuild is non-blocking when an older artifact is active', () => {
    renderSection(buildProvisioning({ status: 'building' }), {
      ...provider,
      configSatisfied: true,
    });

    expect(
      screen.getByText(/Updating the worker base image in the background/),
    ).toHaveTextContent(/existing tasks keep using the current image/);
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

describe('ComputeProviderSection advanced settings', () => {
  const dockerProvider: ComputeProviderStatus = {
    provider: 'docker',
    label: 'Local Docker',
    description: 'Local Docker sandboxes.',
    supportsSnapshots: false,
    fields: [
      {
        envVarName: 'DOCKER_STANDBY_MAX_COUNT',
        label: 'Maximum retained tasks',
        required: false,
        category: 'infrastructure',
        advanced: true,
        input: { type: 'number', min: 0, step: 1, placeholder: '10' },
        runtimeSatisfied: false,
        savedSatisfied: false,
        defaultSatisfied: false,
        setupProvisionable: false,
      },
    ],
    runtimeConfigSatisfied: true,
    savedConfigSatisfied: true,
    configSatisfied: true,
    infrastructureSatisfied: true,
  };

  it('keeps provider overrides collapsed until requested and saves edits', () => {
    const onSave = vi.fn();
    render(
      <ComputeProviderSection
        provider={dockerProvider}
        isDefault
        onSave={onSave}
        onClear={vi.fn()}
        savePending={false}
        clearPending={false}
      />,
    );

    expect(
      screen.queryByLabelText('Maximum retained tasks (optional)'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }));
    const maxCount = screen.getByLabelText('Maximum retained tasks (optional)');
    expect(maxCount).toHaveAttribute('type', 'number');

    fireEvent.change(maxCount, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    expect(onSave).toHaveBeenCalledWith('docker', {
      DOCKER_STANDBY_MAX_COUNT: '4',
    });
  });

  it('shows process environment overrides as locked', () => {
    render(
      <ComputeProviderSection
        provider={{
          ...dockerProvider,
          fields: [
            {
              ...dockerProvider.fields[0]!,
              runtimeSatisfied: true,
              savedValue: '6',
            },
          ],
        }}
        isDefault
        onSave={vi.fn()}
        onClear={vi.fn()}
        savePending={false}
        clearPending={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }));
    expect(
      screen.getByLabelText('Maximum retained tasks (optional)'),
    ).toBeDisabled();
  });
});
