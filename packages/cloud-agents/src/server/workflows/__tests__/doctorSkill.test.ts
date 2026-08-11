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
      'call `complete_doctor_report` with that full report as the final workflow action',
    );
  });

  it('covers all goals and distinguishes failure ownership', () => {
    const skillContent = readSkillContent();

    for (const goal of [
      'environment_start',
      'service_start',
      'preview_reachability',
      'visual_proof',
      'test_execution',
      'performance',
      'failure_ownership',
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
});
