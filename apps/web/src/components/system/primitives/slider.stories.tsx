'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Slider } from './slider';

const meta = {
  title: 'Foundations/Primitives/Slider',
  component: Slider,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    defaultValue: {
      control: 'object',
      description: 'The default value(s) of the slider',
    },
    value: {
      control: 'object',
      description: 'The controlled value(s) of the slider',
    },
    min: {
      control: 'number',
      description: 'The minimum value of the slider',
    },
    max: {
      control: 'number',
      description: 'The maximum value of the slider',
    },
    step: {
      control: 'number',
      description: 'The step increment value',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the slider is disabled',
    },
    orientation: {
      control: 'select',
      options: ['horizontal', 'vertical'],
      description: 'The orientation of the slider',
    },
    className: {
      control: 'text',
      description: 'Additional CSS classes',
    },
  },
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default single slider
export const Default: Story = {
  args: {
    defaultValue: [50],
    min: 0,
    max: 100,
    className: 'w-[300px]',
  },
};

// Single slider with custom range
export const CustomRange: Story = {
  render: () => (
    <div className="w-[300px] space-y-6">
      <div>
        <label className="text-sm font-medium mb-2 block">
          Temperature (0-40°C)
        </label>
        <Slider defaultValue={[25]} min={0} max={40} />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">Volume (0-11)</label>
        <Slider defaultValue={[7]} min={0} max={11} />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">
          Year (1900-2024)
        </label>
        <Slider defaultValue={[1990]} min={1900} max={2024} />
      </div>
    </div>
  ),
};

// Range slider (multiple thumbs)
export const RangeSlider: Story = {
  render: () => (
    <div className="w-[300px] space-y-6">
      <div>
        <label className="text-sm font-medium mb-2 block">Price Range</label>
        <Slider defaultValue={[25, 75]} min={0} max={100} />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">Age Range</label>
        <Slider defaultValue={[18, 65]} min={0} max={100} />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">
          Time Range (hours)
        </label>
        <Slider defaultValue={[9, 17]} min={0} max={24} />
      </div>
    </div>
  ),
};

// Different step sizes
export const StepSizes: Story = {
  render: () => (
    <div className="w-[300px] space-y-6">
      <div>
        <label className="text-sm font-medium mb-2 block">
          Step: 1 (default)
        </label>
        <Slider defaultValue={[50]} step={1} />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">Step: 5</label>
        <Slider defaultValue={[50]} step={5} />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">Step: 10</label>
        <Slider defaultValue={[50]} step={10} />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">Step: 25</label>
        <Slider defaultValue={[50]} step={25} />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">
          Step: 0.1 (decimal)
        </label>
        <Slider defaultValue={[5.5]} min={0} max={10} step={0.1} />
      </div>
    </div>
  ),
};

// Disabled state
export const Disabled: Story = {
  render: () => (
    <div className="w-[300px] space-y-6">
      <div>
        <label className="text-sm font-medium mb-2 block">
          Disabled Single
        </label>
        <Slider defaultValue={[50]} disabled />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">Disabled Range</label>
        <Slider defaultValue={[25, 75]} disabled />
      </div>
    </div>
  ),
};

// Controlled slider with value display
export const Controlled: Story = {
  render: () => {
    const [value, setValue] = useState([50]);
    const [rangeValue, setRangeValue] = useState([25, 75]);

    return (
      <div className="w-[300px] space-y-6">
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="text-sm font-medium">Single Value</label>
            <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
              {value[0]}
            </span>
          </div>
          <Slider value={value} onValueChange={setValue} />
        </div>
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="text-sm font-medium">Range Values</label>
            <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
              {rangeValue[0]} - {rangeValue[1]}
            </span>
          </div>
          <Slider value={rangeValue} onValueChange={setRangeValue} />
        </div>
      </div>
    );
  },
};

// Vertical orientation
export const Vertical: Story = {
  render: () => (
    <div className="flex gap-8 h-[200px]">
      <div className="flex flex-col items-center">
        <label className="text-sm font-medium mb-2">Single</label>
        <Slider defaultValue={[50]} orientation="vertical" />
      </div>
      <div className="flex flex-col items-center">
        <label className="text-sm font-medium mb-2">Range</label>
        <Slider defaultValue={[25, 75]} orientation="vertical" />
      </div>
      <div className="flex flex-col items-center">
        <label className="text-sm font-medium mb-2">Disabled</label>
        <Slider defaultValue={[30]} orientation="vertical" disabled />
      </div>
    </div>
  ),
};

// Multiple sliders with different widths
export const Sizes: Story = {
  render: () => (
    <div className="space-y-6">
      <div>
        <label className="text-sm font-medium mb-2 block">Small (200px)</label>
        <Slider defaultValue={[50]} className="w-50" />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">Medium (300px)</label>
        <Slider defaultValue={[50]} className="w-[300px]" />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">Large (400px)</label>
        <Slider defaultValue={[50]} className="w-[400px]" />
      </div>
      <div>
        <label className="text-sm font-medium mb-2 block">Full Width</label>
        <Slider defaultValue={[50]} className="w-full max-w-md" />
      </div>
    </div>
  ),
};

// Real-world examples
export const Examples: Story = {
  render: () => {
    const [brightness, setBrightness] = useState([70]);
    const [volume, setVolume] = useState([50]);
    const [playbackSpeed, setPlaybackSpeed] = useState([1]);
    const [zoomLevel, setZoomLevel] = useState([100]);

    return (
      <div className="w-[350px] space-y-6">
        {/* Brightness control */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium flex items-center gap-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
              Brightness
            </label>
            <span className="text-sm text-muted-foreground">
              {brightness[0]}%
            </span>
          </div>
          <Slider value={brightness} onValueChange={setBrightness} />
        </div>

        {/* Volume control */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium flex items-center gap-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
              Volume
            </label>
            <span className="text-sm text-muted-foreground">{volume[0]}%</span>
          </div>
          <Slider value={volume} onValueChange={setVolume} />
        </div>

        {/* Playback speed */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium flex items-center gap-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Playback Speed
            </label>
            <span className="text-sm text-muted-foreground">
              {playbackSpeed[0]}x
            </span>
          </div>
          <Slider
            value={playbackSpeed}
            onValueChange={setPlaybackSpeed}
            min={0.25}
            max={2}
            step={0.25}
          />
        </div>

        {/* Zoom level */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium flex items-center gap-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
                <line x1="11" y1="8" x2="11" y2="14" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
              Zoom
            </label>
            <span className="text-sm text-muted-foreground">
              {zoomLevel[0]}%
            </span>
          </div>
          <Slider
            value={zoomLevel}
            onValueChange={setZoomLevel}
            min={25}
            max={200}
            step={25}
          />
        </div>
      </div>
    );
  },
};

// Color picker example
export const ColorPicker: Story = {
  render: () => {
    const [rgb, setRgb] = useState({ r: [128], g: [128], b: [128] });

    const color = `rgb(${rgb.r[0]}, ${rgb.g[0]}, ${rgb.b[0]})`;

    return (
      <div className="w-[350px] space-y-4">
        <div
          className="h-24 rounded-lg border"
          style={{ backgroundColor: color }}
        />
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex justify-between">
              <label className="text-sm font-medium">Red</label>
              <span className="text-sm font-mono">{rgb.r[0]}</span>
            </div>
            <Slider
              value={rgb.r}
              onValueChange={(v) => setRgb({ ...rgb, r: v })}
              min={0}
              max={255}
              className="data-[slot=slider-range]:bg-red-500"
            />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <label className="text-sm font-medium">Green</label>
              <span className="text-sm font-mono">{rgb.g[0]}</span>
            </div>
            <Slider
              value={rgb.g}
              onValueChange={(v) => setRgb({ ...rgb, g: v })}
              min={0}
              max={255}
              className="data-[slot=slider-range]:bg-green-500"
            />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <label className="text-sm font-medium">Blue</label>
              <span className="text-sm font-mono">{rgb.b[0]}</span>
            </div>
            <Slider
              value={rgb.b}
              onValueChange={(v) => setRgb({ ...rgb, b: v })}
              min={0}
              max={255}
              className="data-[slot=slider-range]:bg-blue-500"
            />
          </div>
        </div>
        <div className="text-sm font-mono text-center p-2 bg-muted rounded">
          {color}
        </div>
      </div>
    );
  },
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    defaultValue: [50],
    min: 0,
    max: 100,
    step: 1,
    disabled: false,
    orientation: 'horizontal',
    className: 'w-[300px]',
  },
};
