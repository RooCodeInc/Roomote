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

  it('keeps browser work delegated to proof-runner', () => {
    expect(skillContent).toContain(
      "Browser automation is the proof-runner subagent's exclusive surface",
    );
    expect(skillContent).toContain('proof runtime unavailable');
    expect(skillContent).toContain(
      'Never load or invoke `agent-browser` (or any other browser automation) from this skill',
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

  it('renders with the baked headless shell and a runtime fallback', () => {
    expect(skillContent).toContain(
      '--browser-executable="${REMOTION_HEADLESS_SHELL_PATH:-/opt/remotion/headless-shell}"',
    );
    expect(skillContent).toContain('npx remotion browser ensure');
  });

  it('delivers through manage_artifacts with canonical URLs only', () => {
    expect(skillContent).toContain('manage_artifacts');
    expect(skillContent).toContain('never invent URLs');
    expect(skillContent).toContain('## Screencasts');
  });
});
