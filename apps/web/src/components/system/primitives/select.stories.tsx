import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './select';
import { Label } from './label';

const meta = {
  title: 'Foundations/Primitives/Select',
  component: Select,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    defaultValue: {
      control: 'text',
      description: 'The default selected value',
    },
    value: {
      control: 'text',
      description: 'The controlled selected value',
    },
    onValueChange: {
      action: 'onValueChange',
      description: 'Callback when the value changes',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the select is disabled',
    },
    open: {
      control: 'boolean',
      description: 'Controlled open state',
    },
  },
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default select
export const Default: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-[180px]">
        <SelectValue placeholder="Select a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="apple">Apple</SelectItem>
        <SelectItem value="banana">Banana</SelectItem>
        <SelectItem value="blueberry">Blueberry</SelectItem>
        <SelectItem value="grapes">Grapes</SelectItem>
        <SelectItem value="pineapple">Pineapple</SelectItem>
      </SelectContent>
    </Select>
  ),
};

// With groups
export const WithGroups: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-(--sidebar-width)">
        <SelectValue placeholder="Select a timezone" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>North America</SelectLabel>
          <SelectItem value="est">Eastern Standard Time (EST)</SelectItem>
          <SelectItem value="cst">Central Standard Time (CST)</SelectItem>
          <SelectItem value="mst">Mountain Standard Time (MST)</SelectItem>
          <SelectItem value="pst">Pacific Standard Time (PST)</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Europe & Africa</SelectLabel>
          <SelectItem value="gmt">Greenwich Mean Time (GMT)</SelectItem>
          <SelectItem value="cet">Central European Time (CET)</SelectItem>
          <SelectItem value="eet">Eastern European Time (EET)</SelectItem>
          <SelectItem value="west">
            Western European Summer Time (WEST)
          </SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Asia</SelectLabel>
          <SelectItem value="msk">Moscow Time (MSK)</SelectItem>
          <SelectItem value="ist">India Standard Time (IST)</SelectItem>
          <SelectItem value="cst_china">China Standard Time (CST)</SelectItem>
          <SelectItem value="jst">Japan Standard Time (JST)</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};

// Disabled states
export const DisabledStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div>
        <Label>Disabled Select</Label>
        <Select disabled>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Disabled select" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="option1">Option 1</SelectItem>
            <SelectItem value="option2">Option 2</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>Select with Disabled Options</Label>
        <Select>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Select an option" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active Option</SelectItem>
            <SelectItem value="disabled1" disabled>
              Disabled Option 1
            </SelectItem>
            <SelectItem value="another">Another Active</SelectItem>
            <SelectItem value="disabled2" disabled>
              Disabled Option 2
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  ),
};

// Different placeholder texts
export const PlaceholderVariations: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Select>
        <SelectTrigger className="w-50">
          <SelectValue placeholder="Choose an option..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
          <SelectItem value="2">Option 2</SelectItem>
        </SelectContent>
      </Select>

      <Select>
        <SelectTrigger className="w-50">
          <SelectValue placeholder="Select your country" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="us">United States</SelectItem>
          <SelectItem value="uk">United Kingdom</SelectItem>
          <SelectItem value="ca">Canada</SelectItem>
        </SelectContent>
      </Select>

      <Select>
        <SelectTrigger className="w-50">
          <SelectValue placeholder="Pick a color" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="red">Red</SelectItem>
          <SelectItem value="blue">Blue</SelectItem>
          <SelectItem value="green">Green</SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};

// Controlled state
export const ControlledState: Story = {
  render: () => {
    const ControlledExample = () => {
      const [value, setValue] = useState<string>('');

      return (
        <div className="space-y-4">
          <div className="p-4 border rounded-md bg-muted">
            <p className="text-sm">
              Current value: <strong>{value || 'None selected'}</strong>
            </p>
          </div>

          <Select value={value} onValueChange={setValue}>
            <SelectTrigger className="w-50">
              <SelectValue placeholder="Select a framework" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="next">Next.js</SelectItem>
              <SelectItem value="remix">Remix</SelectItem>
              <SelectItem value="astro">Astro</SelectItem>
              <SelectItem value="gatsby">Gatsby</SelectItem>
              <SelectItem value="vite">Vite</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex gap-2">
            <button
              onClick={() => setValue('next')}
              className="px-3 py-1 text-sm border rounded-md hover:bg-accent"
            >
              Set to Next.js
            </button>
            <button
              onClick={() => setValue('vite')}
              className="px-3 py-1 text-sm border rounded-md hover:bg-accent"
            >
              Set to Vite
            </button>
            <button
              onClick={() => setValue('')}
              className="px-3 py-1 text-sm border rounded-md hover:bg-accent"
            >
              Clear
            </button>
          </div>
        </div>
      );
    };

    return <ControlledExample />;
  },
};

// Different sizes
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Select>
        <SelectTrigger size="sm" className="w-37.5">
          <SelectValue placeholder="Small size" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
          <SelectItem value="2">Option 2</SelectItem>
          <SelectItem value="3">Option 3</SelectItem>
        </SelectContent>
      </Select>

      <Select>
        <SelectTrigger size="default" className="w-37.5">
          <SelectValue placeholder="Default size" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
          <SelectItem value="2">Option 2</SelectItem>
          <SelectItem value="3">Option 3</SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};

// Form example
export const InForm: Story = {
  render: () => (
    <div className="w-full max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <input
          id="email"
          type="email"
          placeholder="Enter your email"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="country">Country</Label>
        <Select>
          <SelectTrigger id="country" className="w-full">
            <SelectValue placeholder="Select your country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="us">United States</SelectItem>
            <SelectItem value="uk">United Kingdom</SelectItem>
            <SelectItem value="ca">Canada</SelectItem>
            <SelectItem value="au">Australia</SelectItem>
            <SelectItem value="de">Germany</SelectItem>
            <SelectItem value="fr">France</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="language">Preferred Language</Label>
        <Select>
          <SelectTrigger id="language" className="w-full">
            <SelectValue placeholder="Select a language" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="es">Spanish</SelectItem>
            <SelectItem value="fr">French</SelectItem>
            <SelectItem value="de">German</SelectItem>
            <SelectItem value="zh">Chinese</SelectItem>
            <SelectItem value="ja">Japanese</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  ),
};

// With icons
export const WithIcons: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-[250px]">
        <SelectValue placeholder="Select a status" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="online">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            Online
          </span>
        </SelectItem>
        <SelectItem value="away">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-yellow-500" />
            Away
          </span>
        </SelectItem>
        <SelectItem value="busy">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            Do not disturb
          </span>
        </SelectItem>
        <SelectItem value="offline">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-gray-500" />
            Offline
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  ),
};

// Long list with scroll
export const LongList: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-50">
        <SelectValue placeholder="Select a user" />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: 50 }, (_, i) => (
          <SelectItem key={i} value={`user-${i}`}>
            User {i + 1}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ),
};

// Multiple selects
export const MultipleSelects: Story = {
  render: () => {
    const MultiSelectExample = () => {
      const [category, setCategory] = useState('');
      const [subcategory, setSubcategory] = useState('');

      const subcategories: Record<string, string[]> = {
        electronics: ['Phones', 'Laptops', 'Tablets', 'Cameras'],
        clothing: ['Shirts', 'Pants', 'Shoes', 'Accessories'],
        books: ['Fiction', 'Non-fiction', 'Science', 'History'],
        home: ['Furniture', 'Decor', 'Kitchen', 'Garden'],
      };

      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Category</Label>
            <Select
              value={category}
              onValueChange={(val) => {
                setCategory(val);
                setSubcategory('');
              }}
            >
              <SelectTrigger className="w-50">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="electronics">Electronics</SelectItem>
                <SelectItem value="clothing">Clothing</SelectItem>
                <SelectItem value="books">Books</SelectItem>
                <SelectItem value="home">Home & Garden</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Subcategory</Label>
            <Select
              value={subcategory}
              onValueChange={setSubcategory}
              disabled={!category}
            >
              <SelectTrigger className="w-50">
                <SelectValue
                  placeholder={
                    category ? 'Select subcategory' : 'Select category first'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {category &&
                  subcategories[category]?.map((sub) => (
                    <SelectItem key={sub} value={sub.toLowerCase()}>
                      {sub}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {category && subcategory && (
            <div className="p-4 border rounded-md bg-muted">
              <p className="text-sm">
                Selected: <strong>{category}</strong> →{' '}
                <strong>{subcategory}</strong>
              </p>
            </div>
          )}
        </div>
      );
    };

    return <MultiSelectExample />;
  },
};

// Playground
export const Playground: Story = {
  args: {
    defaultValue: undefined,
    disabled: false,
  },
  render: (args) => (
    <Select {...args}>
      <SelectTrigger className="w-50">
        <SelectValue placeholder="Select an option" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Fruits</SelectLabel>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
          <SelectItem value="orange">Orange</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Vegetables</SelectLabel>
          <SelectItem value="carrot">Carrot</SelectItem>
          <SelectItem value="potato">Potato</SelectItem>
          <SelectItem value="tomato">Tomato</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};
