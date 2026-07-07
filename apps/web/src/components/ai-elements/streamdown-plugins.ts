import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import type { PluginConfig } from 'streamdown';

export const streamdownPlugins: PluginConfig = {
  code,
  mermaid,
  math,
  cjk,
};

export const streamdownCodeMermaidCjkPlugins: PluginConfig = {
  code,
  mermaid,
  cjk,
};

export const streamdownCodeCjkPlugins: PluginConfig = {
  code,
  cjk,
};
