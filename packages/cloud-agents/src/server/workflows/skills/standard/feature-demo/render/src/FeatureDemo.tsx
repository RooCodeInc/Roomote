import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { DemoStage, FPS, DEMO_SECONDS } from './DemoStage';
import { PRESETS, BACKDROP, type Preset } from './presets';
import narration from '../props/narration.json';

export { FPS, DEMO_SECONDS };

// Narration can run slightly past the recorded motion; the composition holds
// on the last frame until it finishes.
const narrationEnd = narration.clips.reduce(
  (m, c) => Math.max(m, c.startSeconds + c.durationSeconds),
  0,
);
export const TOTAL_SECONDS = Math.max(DEMO_SECONDS, narrationEnd + 0.4);
export const totalFrames = () => Math.round(TOTAL_SECONDS * FPS);

export const FeatureDemo: React.FC<{ presetId: Preset['id'] }> = ({
  presetId,
}) => {
  const preset = PRESETS[presetId];

  return (
    <AbsoluteFill style={{ background: BACKDROP }}>
      <DemoStage
        canvasW={preset.width}
        canvasH={preset.height}
        pad={preset.pad}
        caption={preset.caption}
        centerPull={preset.centerPull}
        baseScale={preset.baseScale}
      />

      {narration.clips.map((c, i) => (
        <Sequence
          key={i}
          from={Math.round(c.startSeconds * FPS)}
          durationInFrames={Math.round(c.durationSeconds * FPS) + 2}
        >
          <Audio src={staticFile(c.file)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
