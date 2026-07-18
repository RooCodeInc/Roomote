'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { ShowWidgetPreview } from './ShowWidgetPreview';
import type { ShowWidgetPayload } from './show-widget-tool-result';

const meta: Meta<typeof ShowWidgetPreview> = {
  title: 'Surfaces/Task Workspace/ACP/ShowWidgetPreview',
  component: ShowWidgetPreview,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-3xl text-foreground">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

const nativeWidget: ShowWidgetPayload = {
  title: 'Release readiness',
  height: 410,
  textFallback: 'Release readiness: 18 checks passed; staging is ready.',
  css: null,
  html: `
    <div class="rw-stack">
      <div class="rw-row">
        <span class="rw-badge rw-badge--success">Ready</span>
        <span class="rw-muted">Updated just now</span>
      </div>
      <div>
        <div class="rw-kicker">Deployment overview</div>
        <h2>Staging is ready to review</h2>
        <p class="rw-muted">All required checks passed and the preview is healthy.</p>
      </div>
      <div class="rw-grid">
        <div class="rw-stat">
          <span class="rw-stat__label">Checks</span>
          <span class="rw-stat__value">18 / 18</span>
        </div>
        <div class="rw-stat">
          <span class="rw-stat__label">Response time</span>
          <span class="rw-stat__value">124 ms</span>
        </div>
        <div class="rw-stat">
          <span class="rw-stat__label">Revision</span>
          <span class="rw-stat__value"><code>7d9c4f1</code></span>
        </div>
      </div>
      <div class="rw-callout rw-callout--success">
        The deployment matches the expected configuration.
      </div>
    </div>
  `,
};

export const RoomotePrimitives: Story = {
  args: {
    widget: nativeWidget,
  },
};

export const CustomLayoutUsingTokens: Story = {
  args: {
    widget: {
      title: 'Queue health',
      height: 350,
      textFallback: 'Queue health is stable at 72% throughput.',
      html: `
        <div class="meter-card">
          <div class="rw-row heading">
            <div>
              <div class="rw-kicker">Live capacity</div>
              <h2>Queue health</h2>
            </div>
            <span class="rw-badge rw-badge--accent">Stable</span>
          </div>
          <div class="meter"><span></span></div>
          <div class="rw-row legend">
            <strong>72%</strong>
            <span class="rw-muted">36 of 50 workers active</span>
          </div>
        </div>
      `,
      css: `
        .meter-card {
          background: var(--rw-surface);
          border: 1px solid var(--rw-border);
          border-radius: var(--rw-radius-lg);
          padding: var(--rw-space-6);
        }
        .heading { justify-content: space-between; }
        .heading h2 { margin-top: var(--rw-space-1); }
        .meter {
          height: 16px;
          margin: var(--rw-space-6) 0 var(--rw-space-3);
          overflow: hidden;
          border-radius: 999px;
          background: var(--rw-surface-muted);
        }
        .meter span {
          display: block;
          width: 72%;
          height: 100%;
          border-radius: inherit;
          background: var(--rw-accent);
        }
        .legend { justify-content: space-between; }
        .legend strong { color: var(--rw-accent); font-size: 1.5rem; }
      `,
    },
  },
};

export const SemanticHtmlDefaults: Story = {
  args: {
    widget: {
      title: 'Plan comparison',
      height: 360,
      textFallback: 'Option B is recommended.',
      css: null,
      html: `
        <h2>Plan comparison</h2>
        <p>Both options satisfy the requirement, with different tradeoffs.</p>
        <table>
          <thead><tr><th>Option</th><th>Effort</th><th>Risk</th></tr></thead>
          <tbody>
            <tr><td>Incremental</td><td>2 days</td><td>Low</td></tr>
            <tr><td>Replacement</td><td>5 days</td><td>Medium</td></tr>
          </tbody>
        </table>
        <blockquote>Recommendation: start incrementally and validate usage.</blockquote>
      `,
    },
  },
};
