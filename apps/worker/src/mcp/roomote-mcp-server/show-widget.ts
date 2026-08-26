import {
  prepareShowWidget,
  type ShowWidgetInput,
} from '@roomote/cloud-agents/show-widget';

import { errorResult, successResult } from './tool-result.js';
import type { ToolResult } from './types.js';

export {
  clampWidgetHeight,
  sanitizeWidgetCss,
  sanitizeWidgetHtml,
  SHOW_WIDGET_DEFAULT_HEIGHT,
  SHOW_WIDGET_MAX_HEIGHT,
  SHOW_WIDGET_MIN_HEIGHT,
} from '@roomote/cloud-agents/show-widget';

export async function handleShowWidget(
  params: ShowWidgetInput,
): Promise<ToolResult> {
  const result = await prepareShowWidget(params);
  return result.success ? successResult(result) : errorResult(result.error);
}
