import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Switch } from './switch';
import { Label } from './label';

const meta = {
  title: 'Foundations/Primitives/Switch',
  component: Switch,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    checked: {
      control: 'boolean',
      description: 'The controlled checked state of the switch',
    },
    defaultChecked: {
      control: 'boolean',
      description: 'The uncontrolled default checked state',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the switch is disabled',
    },
    onCheckedChange: {
      action: 'checked changed',
      description: 'Event handler called when the checked state changes',
    },
    name: {
      control: 'text',
      description: 'The name of the switch for form submission',
    },
    value: {
      control: 'text',
      description: 'The value of the switch for form submission',
    },
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default switch
export const Default: Story = {
  args: {
    defaultChecked: false,
  },
};

// On/Off states
export const OnOffStates: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Switch defaultChecked={false} />
        <span className="text-sm text-muted-foreground">Off state</span>
      </div>
      <div className="flex items-center gap-4">
        <Switch defaultChecked={true} />
        <span className="text-sm text-muted-foreground">On state</span>
      </div>
    </div>
  ),
};

// With labels
export const WithLabels: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex items-center space-x-2">
        <Switch id="airplane-mode" />
        <Label htmlFor="airplane-mode">Airplane Mode</Label>
      </div>
      <div className="flex items-center space-x-2">
        <Switch id="notifications" defaultChecked />
        <Label htmlFor="notifications">Enable notifications</Label>
      </div>
      <div className="flex items-center space-x-2">
        <Switch id="marketing" />
        <Label htmlFor="marketing">Marketing emails</Label>
      </div>
    </div>
  ),
};

// Disabled states
export const DisabledStates: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex items-center space-x-2">
        <Switch id="disabled-off" disabled />
        <Label htmlFor="disabled-off" className="opacity-50 cursor-not-allowed">
          Disabled (off)
        </Label>
      </div>
      <div className="flex items-center space-x-2">
        <Switch id="disabled-on" disabled defaultChecked />
        <Label htmlFor="disabled-on" className="opacity-50 cursor-not-allowed">
          Disabled (on)
        </Label>
      </div>
    </div>
  ),
};

// Different sizes (using custom styles)
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex items-center space-x-2">
        <Switch className="scale-75" />
        <Label>Small</Label>
      </div>
      <div className="flex items-center space-x-2">
        <Switch />
        <Label>Default</Label>
      </div>
      <div className="flex items-center space-x-2">
        <Switch className="scale-125" />
        <Label>Large</Label>
      </div>
    </div>
  ),
};

// Controlled state
export const Controlled: Story = {
  render: function ControlledSwitch() {
    const [checked, setChecked] = useState(false);

    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center space-x-2">
          <Switch
            id="controlled"
            checked={checked}
            onCheckedChange={setChecked}
          />
          <Label htmlFor="controlled">Controlled switch</Label>
        </div>
        <p className="text-sm text-muted-foreground">
          Current state: <strong>{checked ? 'ON' : 'OFF'}</strong>
        </p>
        <button
          onClick={() => setChecked(!checked)}
          className="px-4 py-2 text-sm bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80"
        >
          Toggle programmatically
        </button>
      </div>
    );
  },
};

// Form integration example
export const FormIntegration: Story = {
  render: function FormExample() {
    const [formData, setFormData] = useState<Record<string, boolean>>({
      notifications: true,
      marketing: false,
      analytics: true,
    });

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      alert('Form submitted with: ' + JSON.stringify(formData, null, 2));
    };

    return (
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="notifications" className="flex flex-col space-y-1">
              <span>Email Notifications</span>
              <span className="text-xs font-normal text-muted-foreground">
                Receive email notifications about your account
              </span>
            </Label>
            <Switch
              id="notifications"
              checked={formData.notifications}
              onCheckedChange={(checked) =>
                setFormData((prev) => ({ ...prev, notifications: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="marketing" className="flex flex-col space-y-1">
              <span>Marketing Emails</span>
              <span className="text-xs font-normal text-muted-foreground">
                Receive emails about new products and features
              </span>
            </Label>
            <Switch
              id="marketing"
              checked={formData.marketing}
              onCheckedChange={(checked) =>
                setFormData((prev) => ({ ...prev, marketing: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="analytics" className="flex flex-col space-y-1">
              <span>Usage Analytics</span>
              <span className="text-xs font-normal text-muted-foreground">
                Allow us to collect anonymous usage data
              </span>
            </Label>
            <Switch
              id="analytics"
              checked={formData.analytics}
              onCheckedChange={(checked) =>
                setFormData((prev) => ({ ...prev, analytics: checked }))
              }
            />
          </div>
        </div>

        <button
          type="submit"
          className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
        >
          Save preferences
        </button>
      </form>
    );
  },
};

// Settings panel example
export const SettingsPanel: Story = {
  render: () => (
    <div className="w-full max-w-md p-6 space-y-6 border rounded-lg">
      <div>
        <h3 className="text-lg font-semibold">Settings</h3>
        <p className="text-sm text-muted-foreground">
          Manage your application preferences
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="dark-mode">Dark mode</Label>
          <Switch id="dark-mode" />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="auto-save">Auto-save</Label>
          <Switch id="auto-save" defaultChecked />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="sound">Sound effects</Label>
          <Switch id="sound" />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="2fa">Two-factor auth</Label>
          <Switch id="2fa" defaultChecked />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="beta" className="opacity-50">
            Beta features
          </Label>
          <Switch id="beta" disabled />
        </div>
      </div>
    </div>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    defaultChecked: false,
    disabled: false,
  },
};
