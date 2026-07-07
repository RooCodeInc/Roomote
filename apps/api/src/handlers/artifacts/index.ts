import { Hono } from 'hono';

import type { Variables } from '../../types';
import {
  createArtifact,
  createPlanArtifact,
  createVisualProofArtifact,
} from './create';
import { getArtifactDownloadUrl } from './download-url';
import { listTaskArtifacts } from './list';
import { getArtifactMetadataByPath } from './metadata';
import { markArtifactUploadComplete } from './upload-complete';

export const artifactsRouter = new Hono<{ Variables: Variables }>();
export const taskArtifactsRouter = new Hono<{ Variables: Variables }>();

artifactsRouter.post('/', createArtifact);
artifactsRouter.post('/plan', createPlanArtifact);
artifactsRouter.post('/visual-proof', createVisualProofArtifact);
artifactsRouter.post('/:id/upload_complete', markArtifactUploadComplete);
artifactsRouter.get('/:id/url', getArtifactDownloadUrl);

taskArtifactsRouter.get('/:taskId/artifacts', listTaskArtifacts);
taskArtifactsRouter.get(
  '/:taskId/artifacts/:path{.+}',
  getArtifactMetadataByPath,
);
