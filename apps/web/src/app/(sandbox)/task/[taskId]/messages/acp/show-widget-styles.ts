/**
 * Versioned presentation vocabulary for sandboxed Roomote widgets. These
 * styles are serialized into srcDoc because the iframe cannot inherit CSS from
 * the task view. Keep public selectors and --rw-* variables backward compatible.
 */
export const SHOW_WIDGET_DEFAULT_CSS = `
:root {
  --rw-background: #ffffff;
  --rw-surface: #fafaf9;
  --rw-surface-muted: #f5f5f4;
  --rw-text: #1c1917;
  --rw-text-muted: #57534e;
  --rw-border: #e7e5e4;
  --rw-primary: #1c1917;
  --rw-primary-foreground: #ffffff;
  --rw-accent: #0f766e;
  --rw-success: #0f766e;
  --rw-warning: #b45309;
  --rw-danger: #dc2626;
  --rw-code-background: #f5f5f4;
  --rw-radius-sm: 0.2rem;
  --rw-radius-md: 0.3rem;
  --rw-radius-lg: 0.55rem;
  --rw-font-sans: ui-sans-serif, system-ui, sans-serif;
  --rw-font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --rw-space-1: 0.25rem;
  --rw-space-2: 0.5rem;
  --rw-space-3: 0.75rem;
  --rw-space-4: 1rem;
  --rw-space-6: 1.5rem;

  /* Backward-compatible aliases for widgets created before the theme API. */
  --rw-fg: var(--rw-text);
  --rw-muted: var(--rw-text-muted);
  --rw-bg: var(--rw-background);
  --rw-card: var(--rw-surface);
  --rw-code-bg: var(--rw-code-background);
}
*, *::before, *::after { box-sizing: border-box; min-width: 0; }
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--rw-text);
  font: 14px/1.5 var(--rw-font-sans);
}
body {
  padding: var(--rw-space-4);
  overflow-x: hidden;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
h1, h2, h3, h4, h5, h6 {
  margin: 0 0 0.6em;
  line-height: 1.25;
  font-weight: 600;
}
h1 { font-size: 1.35rem; }
h2 { font-size: 1.2rem; }
h3 { font-size: 1.05rem; }
p, ul, ol, pre, table, blockquote {
  margin: 0 0 0.75em;
}
ul, ol { padding-left: 1.25em; }
a { color: var(--rw-accent); }
hr { border: 0; border-top: 1px solid var(--rw-border); margin: var(--rw-space-4) 0; }
code, kbd, samp {
  font-family: var(--rw-font-mono);
  font-size: 0.9em;
  background: var(--rw-code-background);
  border-radius: var(--rw-radius-sm);
  padding: 0.1em 0.35em;
}
pre {
  background: var(--rw-code-background);
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-lg);
  padding: 10px 12px;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}
pre code {
  background: transparent;
  padding: 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 0.95em;
}
th, td {
  border-bottom: 1px solid var(--rw-border);
  padding: var(--rw-space-2) var(--rw-space-3);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
th { color: var(--rw-text-muted); font-size: 0.85em; font-weight: 600; }
blockquote {
  border-left: 3px solid var(--rw-border);
  margin-left: 0;
  padding: 0.2em 0 0.2em 0.9em;
  color: var(--rw-muted);
}
img, svg, video {
  max-width: 100%;
  height: auto;
}
.rw-stack { display: flex; flex-direction: column; gap: var(--rw-space-3); }
.rw-row, .row {
  display: flex;
  gap: var(--rw-space-2);
  flex-wrap: wrap;
  align-items: center;
}
.rw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr));
  gap: var(--rw-space-3);
}
.rw-card, .card, .panel {
  background: var(--rw-surface);
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-lg);
  padding: var(--rw-space-4);
}
.rw-muted, .muted { color: var(--rw-text-muted); }
.rw-kicker {
  color: var(--rw-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.rw-badge, .badge {
  display: inline-block;
  border: 1px solid var(--rw-border);
  border-radius: 999px;
  padding: 0.1em 0.55em;
  font-size: 0.85em;
  color: var(--rw-text-muted);
  background: var(--rw-surface-muted);
}
.rw-badge--accent { color: var(--rw-accent); border-color: var(--rw-accent); }
.rw-badge--success { color: var(--rw-success); border-color: var(--rw-success); }
.rw-badge--warning { color: var(--rw-warning); border-color: var(--rw-warning); }
.rw-badge--danger { color: var(--rw-danger); border-color: var(--rw-danger); }
.rw-stat {
  display: flex;
  min-height: 88px;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--rw-space-2);
  background: var(--rw-surface);
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-lg);
  padding: var(--rw-space-4);
}
.rw-stat__label { color: var(--rw-text-muted); font-size: 0.85em; }
.rw-stat__value { font-size: 1.5rem; font-weight: 650; line-height: 1.1; }
.rw-callout {
  border-left: 3px solid var(--rw-accent);
  background: var(--rw-surface-muted);
  border-radius: var(--rw-radius-md);
  padding: var(--rw-space-3) var(--rw-space-4);
}
.rw-callout--success { border-left-color: var(--rw-success); }
.rw-callout--warning { border-left-color: var(--rw-warning); }
.rw-callout--danger { border-left-color: var(--rw-danger); }
.rw-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2rem;
  border: 1px solid var(--rw-primary);
  border-radius: var(--rw-radius-md);
  padding: var(--rw-space-2) var(--rw-space-3);
  color: var(--rw-primary-foreground);
  background: var(--rw-primary);
  font: 600 0.9rem/1 var(--rw-font-sans);
}
`.trim();
