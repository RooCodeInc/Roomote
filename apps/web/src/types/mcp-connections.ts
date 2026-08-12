import { normalizeGrafanaBaseUrl } from '@roomote/types';
import { z } from 'zod';

const requiredSnowflakeField = (label: string) =>
  z.string().trim().min(1, `${label} is required`);

export const saveSnowflakeConnectionSchema = z.object({
  authMethod: z.literal('key_pair').default('key_pair'),
  account: requiredSnowflakeField('Account identifier'),
  username: requiredSnowflakeField('Username'),
  password: z.string().default(''),
  privateKey: z.string(),
  privateKeyPassphrase: z.string(),
  role: requiredSnowflakeField('Role'),
  warehouse: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  database: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

export type SaveSnowflakeConnectionInput = z.infer<
  typeof saveSnowflakeConnectionSchema
>;

export const saveAsanaConnectionSchema = z.object({
  accessToken: z.string().transform((value) => value.trim()),
});

export type SaveAsanaConnectionInput = z.infer<
  typeof saveAsanaConnectionSchema
>;

export const saveGranolaConnectionSchema = z.object({
  apiKey: z.string().transform((value) => value.trim()),
});

export type SaveGranolaConnectionInput = z.infer<
  typeof saveGranolaConnectionSchema
>;

export const saveElevenLabsConnectionSchema = z.object({
  apiKey: z.string().transform((value) => value.trim()),
  voiceId: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'Voice ID is required')),
});

export type SaveElevenLabsConnectionInput = z.infer<
  typeof saveElevenLabsConnectionSchema
>;

export const saveVercelConnectionSchema = z.object({
  accessToken: z.string().transform((value) => value.trim()),
  defaultTeamIdOrSlug: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

export type SaveVercelConnectionInput = z.infer<
  typeof saveVercelConnectionSchema
>;

export const saveXConnectionSchema = z.object({
  bearerToken: z.string().transform((value) => value.trim()),
});

export type SaveXConnectionInput = z.infer<typeof saveXConnectionSchema>;

export const saveGrafanaConnectionSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .min(1, 'Grafana URL is required')
    .url('Grafana URL must be a valid URL')
    .transform((value) => normalizeGrafanaBaseUrl(value)),
  serviceAccountToken: z.string().transform((value) => value.trim()),
});

export type SaveGrafanaConnectionInput = z.infer<
  typeof saveGrafanaConnectionSchema
>;
