import { Composition } from 'remotion';
import { FeatureDemo, FPS, totalFrames } from './FeatureDemo';
import { PRESETS, type Preset } from './presets';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {(Object.values(PRESETS) as Preset[]).map((preset) => (
        <Composition
          key={preset.id}
          id={`Demo-${preset.id}`}
          component={FeatureDemo}
          durationInFrames={totalFrames()}
          fps={FPS}
          width={preset.width}
          height={preset.height}
          defaultProps={{ presetId: preset.id }}
        />
      ))}
    </>
  );
};
