import {
  platformIssueReportSchema,
  type CreatePlatformIssueReportInput,
} from '@roomote/types';

import { catchError, successResult } from './tool-result.js';
import type { ToolResult } from './types.js';

export async function handleReportPlatformIssue(
  params: CreatePlatformIssueReportInput,
): Promise<ToolResult> {
  try {
    const report = platformIssueReportSchema.parse(params);

    return successResult({
      reportCreated: true,
      report,
    });
  } catch (error) {
    return catchError(error);
  }
}
