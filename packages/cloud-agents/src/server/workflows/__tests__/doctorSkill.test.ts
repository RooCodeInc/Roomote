import fs from 'node:fs';
import path from 'node:path';

const skillPath = path.resolve(
  import.meta.dirname,
  '../skills/standard/doctor/SKILL.md',
);

function readSkillContent() {
  return fs.readFileSync(skillPath, 'utf8');
}

describe('doctor guidance', () => {
  it('separates observation, assessment, repair, verification, and reporting', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'The `diagnose_environment` tool only produces a secret-safe `EnvironmentObservation`',
    );
    expect(skillContent).toContain(
      'It is not a Doctor assessment, verification result, or repair authorization.',
    );
    expect(skillContent).toContain(
      'An omitted adapter is not a passing check and is not evidence that the corresponding technology or capability exists.',
    );
    expect(skillContent).toContain('Doctor is read-only by default.');
    expect(skillContent).toContain(
      'After an authorized repair completes, wait for setup to settle again and run `diagnose_environment` once more.',
    );
    expect(skillContent).toContain(
      'Always run a goal-specific independent check before declaring the environment healthy',
    );
    expect(skillContent).toContain(
      'Treat `setup.repository_changes` as a provenance boundary',
    );
    expect(skillContent).toContain(
      'without making the outcome unresolved solely because of that warning',
    );
    expect(skillContent).toContain(
      'call `complete_doctor_report` with that full report as the final workflow action',
    );
  });

  it('derives extensible goals and distinguishes failure ownership', () => {
    const skillContent = readSkillContent();

    for (const goal of [
      'command_execution',
      'background_job_processing',
      'preview_reachability',
      'test_execution',
      'artifact_build',
      'migration_execution',
      'performance',
    ]) {
      expect(skillContent).toContain(`\`${goal}\``);
    }

    for (const owner of [
      'environment_configuration',
      'repository',
      'roomote_platform',
      'external_dependency',
      'undetermined',
    ]) {
      expect(skillContent).toContain(`\`${owner}\``);
    }
  });

  it('does not assume a web or infrastructure stack', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'Do not assume the workload is a web application or that it uses HTTP, a browser, a listening port, a long-running process, PM2, Docker, a database, a build step, or a test suite.',
    );
    expect(skillContent).toContain('Goals are not a universal checklist.');
    expect(skillContent).toContain(
      'These are conditional examples, not required stages.',
    );
    expect(skillContent).toContain(
      'Do not require any particular supervisor, container runtime, network protocol, or user interface unless applicable evidence establishes it.',
    );
    expect(skillContent).toContain(
      'process presence does not prove readiness, an open TCP port does not prove protocol correctness, HTTP success does not prove the requested behavior',
    );
  });

  it('routes mutations through existing authorized workflows', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'transition to the packaged `environment-setup` workflow',
    );
    expect(skillContent).toContain('transition to `implement-changes`');
    expect(skillContent).toContain(
      'never patch customer source as an unreviewed Doctor side effect',
    );
    expect(skillContent).toContain(
      'set the outcome to `platform_issue` and report the failing boundary with sanitized evidence',
    );
    expect(skillContent).toContain(
      '`DoctorReport` is not persisted environment verification.',
    );
    expect(skillContent).toContain(
      'A raw unauthenticated curl failure is not valid preview verification.',
    );
    expect(skillContent).toContain(
      'do not claim an external issue was filed, opened, or created',
    );
  });

  it('requires end-to-end preview verification beyond document status', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'verification is an end-to-end browser journey, not a document-status check.',
    );
    expect(skillContent).toContain(
      'inspect browser console errors, uncaught page errors, and failed or blocked network requests',
    );
    expect(skillContent).toContain(
      'a successful navigation or HTTP 2xx/3xx response is insufficient',
    );
    expect(skillContent).toContain(
      'journey-critical stylesheets, scripts, fonts, fetch/XHR calls, and WebSockets',
    );
    expect(skillContent).toContain(
      'Do not fail an otherwise successful browser journey solely because optional analytics, telemetry, favicon, development-only HMR, or another non-critical request failed.',
    );
    expect(skillContent).toContain(
      'never include cookies, authorization or bypass headers, request or response bodies, or URL query values in the report',
    );
    expect(skillContent).toContain(
      'instead of treating successful document navigation as sufficient; otherwise Doctor did not require a preview',
    );
  });

  it('keeps host and origin repairs narrow and evidence-based', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'The same timeout, connection refusal, authentication failure, CORS error, or host rejection can have different owners.',
    );
    expect(skillContent).toContain(
      'For CORS or allowed-host failures, identify the expected origin or host, reproduce through the actual route, and locate the rejecting boundary.',
    );
    expect(skillContent).toContain(
      'Never repair an origin or host-policy failure with a wildcard, disabled host checking, reflective origin behavior, or broadly permissive CORS.',
    );
  });
});
