import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
    // pages have no local source, so they rely on capture's own loud
    // per-selector failure within the allowed retry.
    expect(skillContent).toContain('Repository-backed surface');
    expect(skillContent).toContain('External public page named by the user');
    expect(skillContent).toContain(
      'the runner resolves every selector live and fails loudly naming any that do not resolve',
    );
  });

  it('runs the capture runner directly instead of delegating to a subagent', () => {
    expect(skillContent).toContain(
      'SCRIPT=/tmp/feature-demo/demo-script.json OUT_DIR=/tmp/feature-demo/work node "$HOME/.agents/skills/feature-demo/capture/capture.mjs"',
    );
    expect(skillContent).toContain(
      'Drive the recording only through the capture runner, which shells the `agent-browser` CLI for every action.',
    );
    expect(skillContent).toContain('proof runtime unavailable');
    expect(skillContent).not.toContain('proof-runner');
    expect(skillContent).not.toContain('Task tool to `proof-runner`');
    expect(skillContent).not.toContain('/tmp/feature-demo/capture.mjs');
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

  it('uses scrolling and pointer cues for interactions', () => {
    const captureRunner = fs.readFileSync(
      path.join(skillDirPath, 'capture/capture.mjs'),
      'utf8',
    );

    // The skill only authors its documented beat vocabulary and uses scrolling
    // and cursor effects to guide attention.
    expect(captureRunner).toContain("beat.a === 'show'");
    expect(skillContent).toContain('THE DEFAULT NARRATED MOVE');
    expect(skillContent).toContain('MOVE BY SCROLLING');
    expect(skillContent).toContain(
      'author scripts using only the beat actions listed above',
    );
    expect(skillContent).not.toContain('{ "a": "focus"');
    expect(skillContent).not.toContain('{ "a": "reset"');
    expect(captureRunner).toContain('const moveStart = now();');
    expect(captureRunner).toContain('pushCursorMove(moveStart, moveEnd, c);');
  });

  it.each(['focus', 'reset'])('rejects the unsupported %s action', (action) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-demo-'));
    const scriptPath = path.join(tempDir, 'demo-script.json');
    fs.writeFileSync(
      scriptPath,
      JSON.stringify({ url: 'https://example.com', beats: [{ a: action }] }),
    );

    try {
      const result = spawnSync(
        process.execPath,
        [path.join(skillDirPath, 'capture/capture.mjs')],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            SCRIPT: scriptPath,
            AGENT_BROWSER_BIN: 'must-not-run-agent-browser',
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`unknown beat action: ${action}`);
      expect(result.stderr).not.toContain('must-not-run-agent-browser');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('asks the advisor for a flowing narration, not sparse labels', () => {
    expect(skillContent).toContain('write the NARRATION FIRST');
    expect(skillContent).toContain(
      'sparse label-style narration makes a hollow video',
    );
  });

  it('records headless only, and reports GPU surfaces as unrecordable', () => {
    const captureRunner = fs.readFileSync(
      path.join(skillDirPath, 'capture/capture.mjs'),
      'utf8',
    );

    // Headless + frame ticker is the whole capture story. A headed path
    // existed for WebGL/3D surfaces but wedged the agent-browser daemon on
    // exactly the longer sessions a narrated demo produces, so those
    // surfaces are now reported as unrecordable by the honest-state gate.
    expect(captureRunner).not.toMatch(/--headed|script\.headed/);
    expect(skillContent).not.toMatch(/"headed":\s*true/);
    expect(captureRunner).toContain("ab('eval', TICKER_JS)");
    expect(captureRunner).toContain('cannot be recorded here');
  });

  it('frames the render project as an adaptable reference template', () => {
    expect(skillContent).toContain('**reference template**');
    // Pin to the three skills relevant to editing a composition, not the
    // full bundle.
    expect(skillContent).toContain(
      'npx -y skills add remotion-dev/skills --skill remotion-markup --skill remotion-render --skill remotion-docs --yes',
    );
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
