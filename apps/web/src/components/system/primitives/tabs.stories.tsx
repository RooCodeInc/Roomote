import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './card';
import { Button } from './button';
import { Input } from './input';
import { Label } from './label';

const meta = {
  title: 'Foundations/Primitives/Tabs',
  component: Tabs,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    defaultValue: {
      control: 'text',
      description:
        'The value of the tab that should be active when initially rendered',
    },
    value: {
      control: 'text',
      description: 'The controlled value of the tab to activate',
    },
    orientation: {
      control: 'select',
      options: ['horizontal', 'vertical'],
      description: 'The orientation of the tabs',
    },
  },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default tabs
export const Default: Story = {
  render: () => (
    <Tabs defaultValue="account" className="w-[400px]">
      <TabsList>
        <TabsTrigger value="account">Account</TabsTrigger>
        <TabsTrigger value="password">Password</TabsTrigger>
      </TabsList>
      <TabsContent value="account">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>
              Make changes to your account here. Click save when you&apos;re
              done.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="name">Name</Label>
              <Input id="name" defaultValue="Pedro Duarte" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="username">Username</Label>
              <Input id="username" defaultValue="@peduarte" />
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="password">
        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
            <CardDescription>
              Change your password here. After saving, you&apos;ll be logged
              out.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="current">Current password</Label>
              <Input id="current" type="password" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new">New password</Label>
              <Input id="new" type="password" />
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  ),
};

// Multiple tabs
export const MultipleTabs: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-[600px]">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="analytics">Analytics</TabsTrigger>
        <TabsTrigger value="reports">Reports</TabsTrigger>
        <TabsTrigger value="notifications">Notifications</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="space-y-4">
        <div className="p-6 border rounded-lg">
          <h3 className="text-lg font-semibold">Overview</h3>
          <p className="text-sm text-muted-foreground mt-2">
            Welcome to your dashboard. Here&apos;s a summary of your recent
            activity.
          </p>
        </div>
      </TabsContent>
      <TabsContent value="analytics" className="space-y-4">
        <div className="p-6 border rounded-lg">
          <h3 className="text-lg font-semibold">Analytics</h3>
          <p className="text-sm text-muted-foreground mt-2">
            View detailed analytics and metrics for your projects.
          </p>
        </div>
      </TabsContent>
      <TabsContent value="reports" className="space-y-4">
        <div className="p-6 border rounded-lg">
          <h3 className="text-lg font-semibold">Reports</h3>
          <p className="text-sm text-muted-foreground mt-2">
            Generate and download comprehensive reports.
          </p>
        </div>
      </TabsContent>
      <TabsContent value="notifications" className="space-y-4">
        <div className="p-6 border rounded-lg">
          <h3 className="text-lg font-semibold">Notifications</h3>
          <p className="text-sm text-muted-foreground mt-2">
            Manage your notification preferences and settings.
          </p>
        </div>
      </TabsContent>
    </Tabs>
  ),
};

// With icons
export const WithIcons: Story = {
  render: () => (
    <Tabs defaultValue="settings" className="w-[500px]">
      <TabsList>
        <TabsTrigger value="settings">
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
          Settings
        </TabsTrigger>
        <TabsTrigger value="profile">
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
            />
          </svg>
          Profile
        </TabsTrigger>
        <TabsTrigger value="security">
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
            />
          </svg>
          Security
        </TabsTrigger>
      </TabsList>
      <TabsContent value="settings" className="mt-4 p-4 border rounded-lg">
        <h3 className="font-semibold">General Settings</h3>
        <p className="text-sm text-muted-foreground mt-2">
          Manage your application preferences and configuration.
        </p>
      </TabsContent>
      <TabsContent value="profile" className="mt-4 p-4 border rounded-lg">
        <h3 className="font-semibold">Profile Information</h3>
        <p className="text-sm text-muted-foreground mt-2">
          Update your personal information and profile details.
        </p>
      </TabsContent>
      <TabsContent value="security" className="mt-4 p-4 border rounded-lg">
        <h3 className="font-semibold">Security Settings</h3>
        <p className="text-sm text-muted-foreground mt-2">
          Configure security options and two-factor authentication.
        </p>
      </TabsContent>
    </Tabs>
  ),
};

// Disabled tabs
export const DisabledTabs: Story = {
  render: () => (
    <Tabs defaultValue="active" className="w-[400px]">
      <TabsList>
        <TabsTrigger value="active">Active</TabsTrigger>
        <TabsTrigger value="disabled" disabled>
          Disabled
        </TabsTrigger>
        <TabsTrigger value="another">Another</TabsTrigger>
        <TabsTrigger value="also-disabled" disabled>
          Also Disabled
        </TabsTrigger>
      </TabsList>
      <TabsContent value="active" className="p-4 border rounded-lg">
        <p>This tab is active and can be selected.</p>
      </TabsContent>
      <TabsContent value="another" className="p-4 border rounded-lg">
        <p>This is another active tab.</p>
      </TabsContent>
    </Tabs>
  ),
};

// Vertical orientation
export const VerticalOrientation: Story = {
  render: () => (
    <Tabs
      defaultValue="account"
      orientation="vertical"
      className="flex gap-4 w-[600px]"
    >
      <TabsList className="flex-col h-auto w-50">
        <TabsTrigger value="account" className="w-full justify-start">
          Account Settings
        </TabsTrigger>
        <TabsTrigger value="appearance" className="w-full justify-start">
          Appearance
        </TabsTrigger>
        <TabsTrigger value="notifications" className="w-full justify-start">
          Notifications
        </TabsTrigger>
        <TabsTrigger value="privacy" className="w-full justify-start">
          Privacy & Security
        </TabsTrigger>
      </TabsList>
      <div className="flex-1">
        <TabsContent value="account">
          <Card>
            <CardHeader>
              <CardTitle>Account Settings</CardTitle>
              <CardDescription>
                Manage your account details and preferences.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    defaultValue="user@example.com"
                  />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    type="tel"
                    placeholder="+1 (555) 000-0000"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="appearance">
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>
                Customize the look and feel of the application.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Theme settings and visual preferences will appear here.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <CardTitle>Notifications</CardTitle>
              <CardDescription>
                Configure how and when you receive notifications.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Notification preferences will appear here.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="privacy">
          <Card>
            <CardHeader>
              <CardTitle>Privacy & Security</CardTitle>
              <CardDescription>
                Manage your privacy settings and security options.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Privacy and security settings will appear here.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </div>
    </Tabs>
  ),
};

// Controlled state
export const ControlledState: Story = {
  render: function ControlledTabs() {
    const [activeTab, setActiveTab] = useState('tab1');

    return (
      <div className="space-y-4 w-[500px]">
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveTab('tab1')}
          >
            Go to Tab 1
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveTab('tab2')}
          >
            Go to Tab 2
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveTab('tab3')}
          >
            Go to Tab 3
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="tab1">Tab 1</TabsTrigger>
            <TabsTrigger value="tab2">Tab 2</TabsTrigger>
            <TabsTrigger value="tab3">Tab 3</TabsTrigger>
          </TabsList>
          <TabsContent value="tab1" className="p-4 border rounded-lg">
            <h3 className="font-semibold">First Tab</h3>
            <p className="text-sm text-muted-foreground mt-2">
              This is the content of the first tab. Current tab: {activeTab}
            </p>
          </TabsContent>
          <TabsContent value="tab2" className="p-4 border rounded-lg">
            <h3 className="font-semibold">Second Tab</h3>
            <p className="text-sm text-muted-foreground mt-2">
              This is the content of the second tab. Current tab: {activeTab}
            </p>
          </TabsContent>
          <TabsContent value="tab3" className="p-4 border rounded-lg">
            <h3 className="font-semibold">Third Tab</h3>
            <p className="text-sm text-muted-foreground mt-2">
              This is the content of the third tab. Current tab: {activeTab}
            </p>
          </TabsContent>
        </Tabs>

        <p className="text-sm text-muted-foreground">
          Active tab state:{' '}
          <code className="bg-muted px-1 py-0.5 rounded">{activeTab}</code>
        </p>
      </div>
    );
  },
};

// Tabs as navigation
export const TabsAsNavigation: Story = {
  render: () => (
    <div className="w-[600px]">
      <Tabs defaultValue="dashboard" className="space-y-4">
        <div className="border-b">
          <TabsList className="h-auto p-0 bg-transparent rounded-none">
            <TabsTrigger
              value="dashboard"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              Dashboard
            </TabsTrigger>
            <TabsTrigger
              value="projects"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              Projects
            </TabsTrigger>
            <TabsTrigger
              value="tasks"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              Tasks
            </TabsTrigger>
            <TabsTrigger
              value="team"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              Team
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="dashboard">
          <div className="grid gap-4">
            <h2 className="text-2xl font-bold">Dashboard</h2>
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 border rounded-lg">
                <p className="text-sm text-muted-foreground">Total Projects</p>
                <p className="text-2xl font-bold">12</p>
              </div>
              <div className="p-4 border rounded-lg">
                <p className="text-sm text-muted-foreground">Active Tasks</p>
                <p className="text-2xl font-bold">28</p>
              </div>
              <div className="p-4 border rounded-lg">
                <p className="text-sm text-muted-foreground">Team Members</p>
                <p className="text-2xl font-bold">8</p>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="projects">
          <div className="space-y-4">
            <h2 className="text-2xl font-bold">Projects</h2>
            <p className="text-muted-foreground">
              Manage and view all your projects in one place.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="tasks">
          <div className="space-y-4">
            <h2 className="text-2xl font-bold">Tasks</h2>
            <p className="text-muted-foreground">
              Track and manage your tasks efficiently.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="team">
          <div className="space-y-4">
            <h2 className="text-2xl font-bold">Team</h2>
            <p className="text-muted-foreground">
              Collaborate with your team members.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  ),
};

// Custom styled tabs
export const CustomStyled: Story = {
  render: () => (
    <Tabs defaultValue="option1" className="w-[400px]">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="option1">Option 1</TabsTrigger>
        <TabsTrigger value="option2">Option 2</TabsTrigger>
        <TabsTrigger value="option3">Option 3</TabsTrigger>
      </TabsList>
      <TabsContent value="option1" className="mt-4">
        <div className="p-6 bg-gradient-to-r from-purple-500 to-pink-500 text-white rounded-lg">
          <h3 className="text-lg font-semibold">Option 1 Selected</h3>
          <p className="mt-2">
            Custom styled content area with gradient background.
          </p>
        </div>
      </TabsContent>
      <TabsContent value="option2" className="mt-4">
        <div className="p-6 bg-gradient-to-r from-blue-500 to-teal-500 text-white rounded-lg">
          <h3 className="text-lg font-semibold">Option 2 Selected</h3>
          <p className="mt-2">
            Another custom styled content with different gradient.
          </p>
        </div>
      </TabsContent>
      <TabsContent value="option3" className="mt-4">
        <div className="p-6 bg-gradient-to-r from-orange-500 to-red-500 text-white rounded-lg">
          <h3 className="text-lg font-semibold">Option 3 Selected</h3>
          <p className="mt-2">
            Third option with its own unique gradient style.
          </p>
        </div>
      </TabsContent>
    </Tabs>
  ),
};

// Playground - interactive story
export const Playground: Story = {
  args: {
    defaultValue: 'tab1',
    orientation: 'horizontal',
  },
  render: (args) => (
    <Tabs {...args} className="w-[400px]">
      <TabsList>
        <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        <TabsTrigger value="tab3">Tab 3</TabsTrigger>
      </TabsList>
      <TabsContent value="tab1" className="p-4 border rounded-lg mt-2">
        Content for Tab 1
      </TabsContent>
      <TabsContent value="tab2" className="p-4 border rounded-lg mt-2">
        Content for Tab 2
      </TabsContent>
      <TabsContent value="tab3" className="p-4 border rounded-lg mt-2">
        Content for Tab 3
      </TabsContent>
    </Tabs>
  ),
};
