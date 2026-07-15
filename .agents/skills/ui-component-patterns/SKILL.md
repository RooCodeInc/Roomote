---
name: ui-component-patterns
description: Guidelines and canonical patterns for building UI in the Roomote web application. Use when creating new pages, components, dialogs, forms, or modifying existing UI in `apps/web/`.
---

# UI Component Patterns

## Description

Guidelines and canonical patterns for building UI in the Roomote web application. Use when creating new pages, components, dialogs, forms, or modifying existing UI in `apps/web/`.

## Trigger Conditions

- Creating or modifying React components in `apps/web/src/`
- Building new pages or features with UI
- Working on settings pages, dialogs, forms, or card-based layouts
- Adding loading states, empty states, or error states

---

## Import Conventions

All UI components and icons are imported from a single barrel:

```tsx
// UI Components
import {
  Button,
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
  Badge,
  Skeleton,
  Form, FormField, FormItem, FormLabel, FormControl,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Switch,
  Input,
  Label,
  Alert, AlertDescription,
} from '@/components/system';

// Icons (re-exported from lucide-react via barrel)
import { Settings, Users, ArrowRight, Loader2, Check } from '@/components/system';

// Settings components
import { Section } from '@/components/settings';

// Layout components
import { PageContainer, PageTitle } from '@/components/layout';

// State components
import { EmptyState, ErrorState } from '@/components/system';
```

**Never** import directly from `lucide-react` — always use the barrel.

---

## Page Structure

Pages follow a consistent two-layer pattern:

```tsx
// page.tsx — thin wrapper, validates params, renders main component
'use client';

import { PageContainer, PageTitle } from '@/components/layout';
import { MyFeature } from './MyFeature';

export default function Page() {
  return (
    <PageContainer>
      <div className="space-y-3">
        <PageTitle title="My Feature" />
        <MyFeature />
      </div>
    </PageContainer>
  );
}
```

```tsx
// MyFeature.tsx — main component, owns data fetching and state
'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/trpc/client';
// ... component implementation
```

`PageContainer` provides `gap-6 p-6` base spacing. Use `wide={true}` for full-width pages (settings, usage analytics).

---

## Card Composition

Cards MUST always use subcomponents. Never dump raw content with padding overrides.

### Analytics Summary Cards

Analytics overview metrics in `apps/web/src/app/(authenticated)/analytics/`
must use the shared `AnalyticsSummaryCardsGrid` and `AnalyticsSummaryCard`
components. Build new analytics summary rows like the PR analytics cards:
tight `gap-0.5` grid, unbordered `bg-card p-4` metric blocks, muted
medium-weight labels, large semibold values, and a muted secondary line. The
secondary/footer line should carry concrete context for the metric whenever
possible, such as the selected time period or the denominator behind an average.
Do not wrap the row in an extra padded card or add bordered inner tiles for
sibling analytics views.

### Full card (with header, content, footer)

```tsx
<Card>
  <CardHeader>
    <CardTitle>Review Changes</CardTitle>
    <CardDescription>Review the proposed changes before merging.</CardDescription>
  </CardHeader>
  <CardContent>
    {/* CardContent defaults to text-sm space-y-4 */}
    <p>The following files will be modified:</p>
    <ul>...</ul>
  </CardContent>
  <CardFooter align="end">
    <Button variant="outline">Cancel</Button>
    <Button>Merge</Button>
  </CardFooter>
</Card>
```

### CardFooter alignment

Use the `align` prop instead of className:
```tsx
<CardFooter align="between">  {/* not className="justify-between" */}
<CardFooter align="end">      {/* not className="justify-end" */}
<CardFooter align="center">   {/* not className="justify-center" */}
```

### Card with bordered header

```tsx
<Card>
  <CardHeader className="border-b">
    <CardTitle>Section Title</CardTitle>
  </CardHeader>
  <CardContent>...</CardContent>
</Card>
```

---

## Dialog Composition

### Sizing

Use the `size` prop on `DialogContent`:

```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent size="lg">  {/* sm | md | lg | xl | 2xl | max */}
    <DialogHeader>
      <DialogTitle>Edit Project</DialogTitle>
      <DialogDescription>Update the project configuration.</DialogDescription>
    </DialogHeader>
    {/* content */}
    <DialogFooter>
      <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button onClick={handleSave}>Save</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Never** override width via className. Use size prop.

Dialogs are scrollable by default — no need to add `max-h-[90vh] overflow-y-auto`.

### Dialog state management

Dialogs are always controlled via `open` + `onOpenChange` props:

```tsx
const [isOpen, setIsOpen] = useState(false);

<Dialog open={isOpen} onOpenChange={setIsOpen}>
  <DialogContent size="md">...</DialogContent>
</Dialog>
```

---

## Settings Page Pattern

### Section component

All settings cards use the `Section` component from `@/components/settings`:

```tsx
import { Section } from '@/components/settings';
import { RefreshCw } from '@/components/system';

<Section icon={RefreshCw} title="Task Sync">
  <div className="space-y-6">
    <FormField
      control={control}
      name="enableTaskSync"
      render={({ field }) => (
        <FormControl>
          <Switch checked={field.value} onCheckedChange={field.onChange} />
        </FormControl>
      )}
    />
    <p>Save all extension tasks to Roomote.</p>
  </div>
</Section>
```

### Section with action slot (for toggle switches)

```tsx
<Section
  icon={Bell}
  title="Push Notifications"
  action={<Switch checked={enabled} onCheckedChange={setEnabled} />}
>
  <p>Receive notifications when tasks complete or need attention.</p>
</Section>
```

### Settings page form architecture

Settings pages use a shared form with child sections accessing via `useFormContext`:

```tsx
// Parent: owns the form
const form = useForm<UpdateSettings>({
  resolver: zodResolver(updateSettingsSchema),
  defaultValues: getFormValues(data),
});

<Form {...form}>
  <ChildSectionA />
  <ChildSectionB />
</Form>

// Child: accesses form via context
const { control, watch, formState: { isSubmitting } } = useFormContext<UpdateSettings>();
```

---

## Internal-Only UI

When adding internal-only product UI in `apps/web/`:

- Default it behind the user-level `Show Debug UI` setting.
- Prefer Tailwind `debug:` utilities when that is enough to keep the normal UI clean.
- Reach for heavier gating only when the surface cannot be handled cleanly with `debug:` alone.

---

## Form Pattern

### Standard form with validation

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import {
  Form, FormField, FormItem, FormLabel, FormControl, FormMessage,
  Button, Input,
} from '@/components/system';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email(),
});

type FormValues = z.infer<typeof schema>;

export function MyForm() {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '' },
  });

  const onSubmit = async (values: FormValues) => {
    const result = await createThing(values);
    if (result.success) {
      toast.success('Created successfully');
    } else {
      toast.error(result.error);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : 'Submit'}
        </Button>
      </form>
    </Form>
  );
}
```

### Form inside a dialog

Forms inside dialogs have their own `useForm` (they don't share with parent forms):

```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent size="md">
    <DialogHeader>
      <DialogTitle>Create Item</DialogTitle>
    </DialogHeader>
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* form fields */}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit">Create</Button>
        </DialogFooter>
      </form>
    </Form>
  </DialogContent>
</Dialog>
```

---

## Loading States

### Structural skeletons (the standard)

Loading states must mirror the final content layout using `Skeleton`:

```tsx
// Loading state for a card with header + content + footer
if (isPending) {
  return (
    <Card>
      <CardHeader>
        <CardTitle><Skeleton className="h-6 w-48" /></CardTitle>
        <CardDescription><Skeleton className="h-4 w-72" /></CardDescription>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-32" />
      </CardContent>
      <CardFooter align="end">
        <Skeleton className="h-9 w-24" />
      </CardFooter>
    </Card>
  );
}
```

```tsx
// Loading state for a list
if (isPending) {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}
```

### Error and empty states

```tsx
import { EmptyState, ErrorState } from '@/components/system';

if (isError) {
  return <ErrorState title="Failed to load tasks" />;
}

if (data.length === 0) {
  return (
    <EmptyState
      icon={<CircleOff className="size-6 text-muted-foreground/50" />}
      title="No tasks found"
      description="Create your first task to get started."
    />
  );
}
```

### Standard data loading pattern

```tsx
const { data, isPending, isError } = useQuery(...);

if (isPending) return <StructuralSkeleton />;
if (isError) return <ErrorState title="Failed to load" />;
if (data.length === 0) return <EmptyState title="Nothing here yet" />;

return <ActualContent data={data} />;
```

**Never** use `LoadingState`, `GhostLoader`, or inline spinners for in-page content loading. The `Loading` component from `@/components/layout` is reserved for full-page initial loads only.

---

## Icon Conventions

### Size scale

| Size | Context | Example |
|------|---------|---------|
| `size-3` | Micro: inside xs/sm buttons, badges, status indicators | `<Check className="size-3" />` |
| `size-4` | Standard: buttons, card titles, settings, inline actions | `<Settings className="size-4" />` |
| `size-5` | Navigation: sidebar nav, toolbar buttons | `<Home className="size-5" />` |
| `size-6` | Hero: page headers, empty/error state icons | `<Star className="size-6" />` |

### Auto-sizing

Button and Badge auto-size their child icons:
- **Button**: icons default to `size-4` — don't set explicit sizes
- **Badge**: icons default to `size-3` — don't set explicit sizes

```tsx
// ✅ Correct — Button auto-sizes the icon
<Button><Settings /> Save Settings</Button>

// ❌ Wrong — unnecessary explicit size inside Button
<Button><Settings className="size-4" /> Save Settings</Button>
```

### strokeWidth

Default strokeWidth is 1.5 (set via CSS). Never specify `strokeWidth={1.5}` explicitly. Only set strokeWidth when you need a different value (e.g., `strokeWidth={1}` for hero icons).

---

## Badge Variants

```tsx
// Semantic status badges
<Badge variant="success">Active</Badge>      {/* green */}
<Badge variant="warning">Trial</Badge>       {/* yellow */}
<Badge variant="destructive">Failed</Badge>  {/* red */}

// Standard variants
<Badge variant="default">Cloud</Badge>       {/* primary color */}
<Badge variant="secondary">v2.1</Badge>      {/* muted */}
<Badge variant="outline">Draft</Badge>       {/* border only */}
```

**Never** use className to apply status colors to Badge — use the variant prop.

---

## Spacing Scale

| Value | Pixels | Semantic Use |
|-------|--------|-------------|
| `space-y-1` | 4px | Tight pairs: title + subtitle, label + description |
| `space-y-2` | 8px | Lists, small stacks, form field groups |
| `space-y-3` | 12px | Section content (inside Section.tsx) |
| `space-y-4` | 16px | Card content (CardContent default), form sections |
| `space-y-6` | 24px | Major sections: between cards, page-level sections |

`PageContainer` provides `gap-6 p-6` as the page baseline.

---

## Toast Notifications

Always use `sonner`:

```tsx
import { toast } from 'sonner';

// Success
toast.success('Settings saved');

// Error
toast.error('Failed to save settings');
toast.error(error.message);
```

Pattern for mutations:
```tsx
const mutation = useMutation({
  onSuccess: (data) => {
    if (data.success) {
      toast.success('Updated successfully');
    } else {
      toast.error(data.error);
    }
  },
  onError: (error) => toast.error(error.message),
});
```

---

## Tooltip Pattern

### BasicTooltip — simple cases

For elements that just need a hover tooltip with text:

```tsx
import { BasicTooltip } from '@/components/system';

<BasicTooltip content="Delete this item">
  <Button variant="ghost" size="icon">
    <Trash2 />
  </Button>
</BasicTooltip>

// With positioning
<BasicTooltip content="Settings" side="right">
  <Button variant="ghost"><Settings /></Button>
</BasicTooltip>
```

### Full Tooltip API — complex cases

For rich tooltip content or custom triggers, use the composable API:

```tsx
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/system';

<Tooltip>
  <TooltipTrigger asChild>
    <Button>Hover me</Button>
  </TooltipTrigger>
  <TooltipContent>
    <div className="space-y-1">
      <p className="font-semibold">Rich content</p>
      <p className="text-xs">With multiple lines</p>
    </div>
  </TooltipContent>
</Tooltip>
```

**Never** wrap in `<TooltipProvider>` — `Tooltip` already includes one.

---

## Anti-Patterns

### Do NOT:
- Import icons directly from `lucide-react` — use the barrel from `@/components/system`
- Override Dialog width via className — use the `size` prop
- Override CardFooter alignment via className — use the `align` prop
- Override Badge colors via className for status — use `variant="success"` / `variant="warning"`
- Use `LoadingState` or `GhostLoader` — use structural Skeleton components
- Put raw content in Card without using CardContent subcomponent
- Specify `strokeWidth={1.5}` on icons — it's the CSS default
- Create ad-hoc settings cards with `<Card className="gap-2">` — use `Section` from `@/components/settings`
- Override `text-sm` or `space-y-4` on CardContent — these are now defaults

### DO:
- Import everything from `@/components/system` barrel
- Use Section.tsx for all settings cards
- Use structural Skeletons that mirror final content layout
- Use the component's built-in variants/props before reaching for className
- Follow the spacing scale: 1 → 2 → 3 → 4 → 6
