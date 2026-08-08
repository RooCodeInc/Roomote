import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGED_SKILL_INVOCATIONS } from '../../../packaged-skill-invocations';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);
const skillDirPath = path.resolve(
  thisDirPath,
  '../skills/standard/feature-demo',
);

describe('feature-demo skill', () => {
  const skillContent = fs.readFileSync(
    path.join(skillDirPath, 'SKILL.md'),
    'utf8',
  );

  it('is registered for explicit invocation', () => {
    expect(PACKAGED_SKILL_INVOCATIONS).toContain('feature-demo');
  });

  it('ships the capture runner, pipeline scripts, and render project', () => {
    for (const relativePath of [
      'capture/capture.mjs',
      'scripts/build-narration.mjs',
      'scripts/fit-timing.mjs',
      'render/package.json',
      'render/src/index.ts',
      'render/src/Root.tsx',
      'render/src/FeatureDemo.tsx',
      'render/src/DemoStage.tsx',
      'render/src/presets.ts',
      'render/props/timeline.json',
      'render/props/narration.json',
    ]) {
      expect(
        fs.existsSync(path.join(skillDirPath, relativePath)),
        `${relativePath} must ship with the skill`,
      ).toBe(true);
    }
  });

  it('delegates demo planning to the advisor with parent-owned verification', () => {
    expect(skillContent).toContain(
      'Delegate the creative plan to the `advisor` subagent with the Task tool',
    );
    // The advisor cannot see the live page; the parent must verify selectors.
    expect(skillContent).toContain(
      "Treat the advisor's plan as internal guidance, not finished work",
    );
    // Repository-backed surfaces verify against source; external public
    // pages have no local source, so selectors are validated through a
    // read-only proof-runner pre-flight instead.
    expect(skillContent).toContain('Repository-backed surface');
    expect(skillContent).toContain('External public page named by the user');
    expect(skillContent).toContain(
      'delegate a lightweight resolve-only brief to the `proof-runner`',
    );
  });

  it('keeps browser work delegated to proof-runner', () => {
    expect(skillContent).toContain(
      "Browser automation is the proof-runner subagent's exclusive surface",
    );
    expect(skillContent).toContain('proof runtime unavailable');
    expect(skillContent).toContain(
      'Never load or invoke `agent-browser` (or any other browser automation) from this skill',
    );
  });

  it('stages the capture runner at the sanctioned /tmp path for delegation', () => {
    // Home-directory paths do not survive the delegation boundary, and the
    // proof-runner prompt sanctions exactly this staged path.
    expect(skillContent).toContain(
      'cp "$HOME/.agents/skills/feature-demo/capture/capture.mjs" /tmp/feature-demo/capture.mjs',
    );
    expect(skillContent).toContain('/tmp/feature-demo/capture.mjs');
    // The parent hands off the paths; the proof-runner owns the integrity-
    // verified node invocation, so the skill must not dictate a raw node run.
    expect(skillContent).toContain(
      'Do not dictate the `node` invocation yourself; the proof-runner owns that.',
    );
  });

  it('keeps TTS provider keys out of the sandbox', () => {
    expect(skillContent).toContain(
      'Never ask for, read, or handle TTS provider keys.',
    );
    expect(skillContent).toContain('captions-only');

    const narrationScript = fs.readFileSync(
      path.join(skillDirPath, 'scripts/build-narration.mjs'),
      'utf8',
    );

    // The sandbox-side script talks to the control plane with the run token
    // and must never reference the provider or its key directly.
    expect(narrationScript).toContain('/api/tts/narration');
    expect(narrationScript).toContain('ROOMOTE_CLOUD_TOKEN');
    expect(narrationScript.toLowerCase()).not.toContain('elevenlabs.io');
    expect(narrationScript).not.toContain('xi-api-key');
  });

  it('never commits pipeline outputs into the repository', () => {
    expect(skillContent).toContain(
      'Never commit recordings, renders, node_modules, or props into the repository.',
    );
  });

  it('records headed so GPU-backed canvases do not stall the screencast', () => {
    const captureRunner = fs.readFileSync(
      path.join(skillDirPath, 'capture/capture.mjs'),
      'utf8',
    );

    // Default headed with an explicit opt-out; the flag rides every command.
    expect(captureRunner).toContain(
      "const HEADED = process.env.HEADED !== '0'",
    );
    expect(captureRunner).toContain("HEADED ? ['--headed', ...args] : args");
    expect(skillContent).toContain('records headed by default');
  });

  it('frames the render project as an adaptable reference template', () => {
    expect(skillContent).toContain('**reference template**');
    expect(skillContent).toContain('npx -y skills add remotion-dev/skills');
    expect(skillContent).toContain(
      'The timeline JSON schema is the stable contract',
    );
  });

  it('renders with the baked headless shell and a runtime fallback', () => {
    expect(skillContent).toContain(
      '--browser-executable="${REMOTION_HEADLESS_SHELL_PATH:-/opt/remotion/headless-shell}"',
    );
    expect(skillContent).toContain('npx remotion browser ensure');
  });

  it('reuses the image-baked render dependencies instead of installing', () => {
    // Fast path copies the baked node_modules; npm install is only the
    // adapted-deps / old-snapshot fallback.
    expect(skillContent).toContain(
      'cp -R /opt/feature-demo/render/node_modules /tmp/feature-demo/render/node_modules',
    );
    expect(skillContent).toContain(
      'only if you adapted the composition to add dependencies',
    );
  });

  it('delivers through manage_artifacts with canonical URLs only', () => {
    expect(skillContent).toContain('manage_artifacts');
    expect(skillContent).toContain('never invent URLs');
    expect(skillContent).toContain('## Screencasts');
  });
});
