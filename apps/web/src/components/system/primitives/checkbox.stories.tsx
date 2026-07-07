'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Checkbox } from './checkbox';

const meta = {
  title: 'Foundations/Primitives/Checkbox',
  component: Checkbox,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    checked: {
      control: 'select',
      options: [true, false, 'indeterminate'],
      description: 'The checked state of the checkbox',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the checkbox is disabled',
    },
    required: {
      control: 'boolean',
      description: 'Whether the checkbox is required',
    },
    name: {
      control: 'text',
      description: 'The name of the checkbox for form submission',
    },
    value: {
      control: 'text',
      description: 'The value of the checkbox for form submission',
    },
    onCheckedChange: {
      action: 'checked changed',
      description: 'Callback when the checked state changes',
    },
    className: {
      control: 'text',
      description: 'Additional CSS classes',
    },
  },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default unchecked checkbox
export const Default: Story = {
  args: {
    checked: false,
  },
};

// Checked checkbox
export const Checked: Story = {
  args: {
    checked: true,
  },
};

// Indeterminate checkbox
export const Indeterminate: Story = {
  args: {
    checked: 'indeterminate',
  },
};

// All states
export const States: Story = {
  render: () => (
    <div className="flex items-center gap-8">
      <div className="flex flex-col items-center gap-2">
        <Checkbox checked={false} />
        <span className="text-xs text-muted-foreground">Unchecked</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Checkbox checked={true} />
        <span className="text-xs text-muted-foreground">Checked</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Checkbox checked="indeterminate" />
        <span className="text-xs text-muted-foreground">Indeterminate</span>
      </div>
    </div>
  ),
};

// Disabled states
export const Disabled: Story = {
  render: () => (
    <div className="flex items-center gap-8">
      <div className="flex flex-col items-center gap-2">
        <Checkbox disabled checked={false} />
        <span className="text-xs text-muted-foreground">Disabled</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Checkbox disabled checked={true} />
        <span className="text-xs text-muted-foreground">Disabled Checked</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Checkbox disabled checked="indeterminate" />
        <span className="text-xs text-muted-foreground">
          Disabled Indeterminate
        </span>
      </div>
    </div>
  ),
};

// With labels
export const WithLabel: Story = {
  render: () => (
    <div className="space-y-4">
      <div className="flex items-center space-x-2">
        <Checkbox id="terms" />
        <label
          htmlFor="terms"
          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          Accept terms and conditions
        </label>
      </div>
      <div className="flex items-center space-x-2">
        <Checkbox id="marketing" checked />
        <label
          htmlFor="marketing"
          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          Send me marketing emails
        </label>
      </div>
      <div className="flex items-center space-x-2">
        <Checkbox id="notifications" disabled />
        <label
          htmlFor="notifications"
          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          Enable notifications (disabled)
        </label>
      </div>
    </div>
  ),
};

// Interactive example
export const Interactive: Story = {
  render: function CheckboxWithHooks() {
    const [checked, setChecked] = useState<boolean | 'indeterminate'>(false);

    return (
      <div className="flex flex-col items-center gap-4">
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => {
            if (value === 'indeterminate') {
              setChecked('indeterminate');
            } else {
              setChecked(value as boolean);
            }
          }}
        />
        <div className="text-sm text-muted-foreground">
          State:{' '}
          {checked === 'indeterminate'
            ? 'indeterminate'
            : checked
              ? 'checked'
              : 'unchecked'}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setChecked(false)}
            className="rounded px-2 py-1 text-xs border"
          >
            Uncheck
          </button>
          <button
            onClick={() => setChecked(true)}
            className="rounded px-2 py-1 text-xs border"
          >
            Check
          </button>
          <button
            onClick={() => setChecked('indeterminate')}
            className="rounded px-2 py-1 text-xs border"
          >
            Indeterminate
          </button>
        </div>
      </div>
    );
  },
};

// Form example with multiple checkboxes
export const FormExample: Story = {
  render: function CheckboxForm() {
    const [selectedItems, setSelectedItems] = useState<string[]>([]);

    const items = [
      { id: 'react', label: 'React' },
      { id: 'vue', label: 'Vue' },
      { id: 'angular', label: 'Angular' },
      { id: 'svelte', label: 'Svelte' },
    ];

    const handleCheckedChange = (
      itemId: string,
      checked: boolean | 'indeterminate',
    ) => {
      if (checked === true) {
        setSelectedItems([...selectedItems, itemId]);
      } else {
        setSelectedItems(selectedItems.filter((id) => id !== itemId));
      }
    };

    return (
      <div className="space-y-4">
        <div className="text-sm font-medium">
          Select your favorite frameworks:
        </div>
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-center space-x-2">
              <Checkbox
                id={item.id}
                checked={selectedItems.includes(item.id)}
                onCheckedChange={(checked) =>
                  handleCheckedChange(item.id, checked)
                }
              />
              <label
                htmlFor={item.id}
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
              >
                {item.label}
              </label>
            </div>
          ))}
        </div>
        <div className="text-sm text-muted-foreground">
          Selected:{' '}
          {selectedItems.length > 0 ? selectedItems.join(', ') : 'None'}
        </div>
      </div>
    );
  },
};

// Select all example with indeterminate state
export const SelectAllExample: Story = {
  render: function SelectAllCheckbox() {
    const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());

    const items = ['Item 1', 'Item 2', 'Item 3', 'Item 4'];

    const allChecked = checkedItems.size === items.length;
    const indeterminate =
      checkedItems.size > 0 && checkedItems.size < items.length;

    const handleSelectAll = (checked: boolean | 'indeterminate') => {
      if (checked === true) {
        setCheckedItems(new Set(items));
      } else {
        setCheckedItems(new Set());
      }
    };

    const handleItemCheck = (
      item: string,
      checked: boolean | 'indeterminate',
    ) => {
      const newCheckedItems = new Set(checkedItems);
      if (checked === true) {
        newCheckedItems.add(item);
      } else {
        newCheckedItems.delete(item);
      }
      setCheckedItems(newCheckedItems);
    };

    return (
      <div className="space-y-4">
        <div className="border-b pb-2">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="select-all"
              checked={indeterminate ? 'indeterminate' : allChecked}
              onCheckedChange={handleSelectAll}
            />
            <label
              htmlFor="select-all"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
            >
              Select All
            </label>
          </div>
        </div>
        <div className="space-y-2 pl-6">
          {items.map((item) => (
            <div key={item} className="flex items-center space-x-2">
              <Checkbox
                id={item}
                checked={checkedItems.has(item)}
                onCheckedChange={(checked) => handleItemCheck(item, checked)}
              />
              <label
                htmlFor={item}
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
              >
                {item}
              </label>
            </div>
          ))}
        </div>
        <div className="text-sm text-muted-foreground">
          {checkedItems.size} of {items.length} selected
        </div>
      </div>
    );
  },
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    checked: false,
    disabled: false,
    required: false,
  },
};
