import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Textarea } from './textarea';
import { Label } from './label';
import { Input } from './input';

const meta = {
  title: 'Foundations/Primitives/Textarea',
  component: Textarea,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    placeholder: {
      control: 'text',
      description: 'Placeholder text for the textarea',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the textarea is disabled',
    },
    readOnly: {
      control: 'boolean',
      description: 'Whether the textarea is read-only',
    },
    rows: {
      control: 'number',
      description: 'Number of visible text lines',
    },
    cols: {
      control: 'number',
      description: 'Visible width of the text control',
    },
    maxLength: {
      control: 'number',
      description: 'Maximum number of characters allowed',
    },
    required: {
      control: 'boolean',
      description: 'Whether the textarea is required',
    },
  },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default textarea
export const Default: Story = {
  args: {
    placeholder: 'Type your message here...',
  },
};

// Different sizes
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-4 w-full max-w-md">
      <div>
        <Label htmlFor="small">Small (3 rows)</Label>
        <Textarea
          id="small"
          placeholder="Small textarea..."
          rows={3}
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor="medium">Medium (5 rows)</Label>
        <Textarea
          id="medium"
          placeholder="Medium textarea..."
          rows={5}
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor="large">Large (10 rows)</Label>
        <Textarea
          id="large"
          placeholder="Large textarea..."
          rows={10}
          className="mt-1"
        />
      </div>
    </div>
  ),
};

// With placeholder
export const WithPlaceholder: Story = {
  render: () => (
    <div className="flex flex-col gap-4 w-full max-w-md">
      <Textarea placeholder="Enter your feedback..." />
      <Textarea placeholder="Describe your issue in detail..." rows={5} />
      <Textarea
        placeholder="Write your bio (max 500 characters)"
        maxLength={500}
      />
    </div>
  ),
};

// Disabled state
export const Disabled: Story = {
  render: () => (
    <div className="flex flex-col gap-4 w-full max-w-md">
      <Textarea placeholder="Disabled textarea" disabled />
      <Textarea
        defaultValue="This textarea is disabled and has content"
        disabled
        rows={4}
      />
    </div>
  ),
};

// Readonly state
export const Readonly: Story = {
  render: () => (
    <div className="flex flex-col gap-4 w-full max-w-md">
      <Textarea
        defaultValue="This is a read-only textarea. You can select and copy the text, but you cannot edit it."
        readOnly
        rows={3}
      />
      <Textarea
        defaultValue={`Terms and Conditions

By using this service, you agree to our terms and conditions. This is a read-only field for your reference.

Last updated: January 1, 2024`}
        readOnly
        rows={6}
      />
    </div>
  ),
};

// With rows and cols
export const RowsAndCols: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div>
        <Label>5 rows × 30 cols</Label>
        <Textarea
          placeholder="Fixed dimensions textarea"
          rows={5}
          cols={30}
          className="mt-1"
        />
      </div>
      <div>
        <Label>3 rows × 50 cols</Label>
        <Textarea
          placeholder="Wide textarea"
          rows={3}
          cols={50}
          className="mt-1"
        />
      </div>
      <div>
        <Label>10 rows × 20 cols</Label>
        <Textarea
          placeholder="Tall and narrow"
          rows={10}
          cols={20}
          className="mt-1"
        />
      </div>
    </div>
  ),
};

// Error states
export const ErrorStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4 w-full max-w-md">
      <div>
        <Label htmlFor="error1">With error (aria-invalid)</Label>
        <Textarea
          id="error1"
          placeholder="This field has an error"
          aria-invalid="true"
          className="mt-1"
        />
        <p className="text-sm text-destructive mt-1">This field is required</p>
      </div>
      <div>
        <Label htmlFor="error2">Required field</Label>
        <Textarea
          id="error2"
          placeholder="Required field..."
          required
          aria-invalid="true"
          className="mt-1"
        />
        <p className="text-sm text-destructive mt-1">
          Please fill out this field
        </p>
      </div>
    </div>
  ),
};

// With character count
export const WithCharacterCount: Story = {
  render: () => {
    const CharCountTextarea = () => {
      const [value, setValue] = useState('');
      const maxLength = 200;

      return (
        <div className="w-full max-w-md">
          <Label htmlFor="char-count">Message</Label>
          <Textarea
            id="char-count"
            placeholder="Enter your message..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={maxLength}
            rows={4}
            className="mt-1"
          />
          <div className="flex justify-between mt-1">
            <p className="text-sm text-muted-foreground">
              Max {maxLength} characters
            </p>
            <p
              className={`text-sm ${value.length >= maxLength ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {value.length}/{maxLength}
            </p>
          </div>
        </div>
      );
    };

    return <CharCountTextarea />;
  },
};

// Form integration example
export const FormIntegration: Story = {
  render: () => {
    const ContactForm = () => {
      const [formData, setFormData] = useState({
        name: '',
        email: '',
        message: '',
      });

      const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        alert('Form submitted: ' + JSON.stringify(formData, null, 2));
      };

      return (
        <form onSubmit={handleSubmit} className="w-full max-w-md space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              type="text"
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              required
            />
          </div>

          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) =>
                setFormData({ ...formData, email: e.target.value })
              }
              required
            />
          </div>

          <div>
            <Label htmlFor="message">Message</Label>
            <Textarea
              id="message"
              placeholder="Your message..."
              value={formData.message}
              onChange={(e) =>
                setFormData({ ...formData, message: e.target.value })
              }
              rows={5}
              required
            />
          </div>

          <button
            type="submit"
            className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
          >
            Send Message
          </button>
        </form>
      );
    };

    return <ContactForm />;
  },
};

// Auto-resize example
export const AutoResize: Story = {
  render: () => (
    <div className="w-full max-w-md">
      <Label htmlFor="auto">Auto-resizing textarea (using field-sizing)</Label>
      <Textarea
        id="auto"
        placeholder="This textarea uses field-sizing-content to auto-resize as you type..."
        className="mt-1"
      />
      <p className="text-sm text-muted-foreground mt-1">
        The textarea automatically adjusts its height based on content
      </p>
    </div>
  ),
};

// With default value
export const WithDefaultValue: Story = {
  render: () => (
    <div className="flex flex-col gap-4 w-full max-w-md">
      <Textarea
        defaultValue="This textarea has a default value that can be edited."
        rows={3}
      />
      <Textarea
        defaultValue={`Multiple line
default value
that spans several lines`}
        rows={5}
      />
    </div>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    placeholder: 'Enter text...',
    disabled: false,
    readOnly: false,
    rows: 4,
    required: false,
  },
};
