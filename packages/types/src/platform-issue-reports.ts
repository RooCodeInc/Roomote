import { z } from 'zod';

export const platformIssueReportSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4_000),
});

export type PlatformIssueReport = z.output<typeof platformIssueReportSchema>;

export type CreatePlatformIssueReportInput = z.infer<
  typeof platformIssueReportSchema
>;
