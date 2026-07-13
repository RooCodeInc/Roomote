'use client';

import {
  useState,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from 'react';
import YAML from 'yaml';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  FileCode,
  Eye,
  Settings2,
} from '@/components/system';

import {
  type EnvironmentConfig,
  environmentConfigSchema,
} from '@roomote/types';

import {
  Alert,
  AlertDescription,
  Button,
  Textarea,
  Badge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/system';
import { cn } from '@/lib/utils';

import { EnvironmentPreviewContent } from './EnvironmentPreview';
import { useRepositories } from '@/hooks/source-control';
import { configToYaml } from './yaml-utils';
import { VisualEnvironmentEditor } from './VisualEnvironmentEditor';

function getDefaultYamlTemplate(repositoryNames: string[] = []) {
  const repoLines =
    repositoryNames.length > 0
      ? repositoryNames.map((name) => `  - repository: ${name}`).join('\n')
      : `  - repository: owner/repo-1
  - repository: owner/repo-2`;

  return `# Environment Configuration
name: My Environment
description: A brief description of this environment.

# Optional: Instructions for LLM agents working in this environment.
# These are delivered through the startup environment-instructions block to provide environment-specific context.
# agentInstructions: |
#   This is a monorepo. The frontend is in packages/web and the API is in packages/api.
#   Always run tests before committing changes.

# Required: Repositories to include in this environment.
repositories:
${repoLines}

# Optional: Shared mise tool versions for the workspace root.
# Useful for workspace-root commands and as a fallback when a repo
# does not already pin a tool locally.
# tool_versions:
#   node: "22.14.0"
#   python: "3.12.1"
#
# Optional: You can specify repo-local fallback tool versions and commands
# to run in each repository.
# repositories:
#   - repository: owner/repo-name
#     branch: main
#     tool_versions:
#       node: "20.11.0"
#       python: "3.12.1"
#     commands:
#       - name: Install dependencies
#         run: pnpm install
#         timeout: 120
#       - name: Start web server
#         run: pnpm dev
#         detached: true
#         logfile: /tmp/dev-server.log

# Optional: Services to start (redis, postgres, etc.)
# services:
#   - redis7
#   - postgres16

# Optional: Build and start a Docker Compose project or a single Dockerfile
# after its repository is cloned. Paths are relative to the selected repo.
# container_projects:
#   - type: compose
#     name: app
#     repository: owner/repo-name
#     files:
#       - compose.yaml
#     services:
#       - web
#     ports:
#       - named_port: WEB
#         service: web
#         container_port: 3000
#   - type: dockerfile
#     name: worker
#     repository: owner/repo-name
#     context: .
#     dockerfile: Dockerfile

# Optional: Install extra skills during environment setup.
# Group skills by owner/repo source.
# skills:
#   dbt-labs/dbt-agent-skills: all # installs all skills from this source
#   anthropics/skills:
#     - frontend-design
#   vercel-labs/agent-skills:
#     - web-design-guidelines

# Optional: Inline manual skills managed directly in the environment config.
# manualSkills:
#   - name: my-manual-skill
#     description: Adds custom Roomote behavior.
#     content: |
#       # My Manual Skill
#
#       Custom instructions go here.

# Advanced (optional): Custom MCP servers for this environment.
# Useful for environment-specific MCP integrations and tools.
# Transport is inferred from url vs command.
# mcpServers:
#   customDocs:
#     url: https://mcp.example.com/docs
#   internalTooling:
#     command: npx
#     args:
#       - -y
#       - @acme/internal-mcp
`;
}

interface ValidationResult {
  success: boolean;
  data?: EnvironmentConfig;
  errors?: string[];
  fieldErrors?: Record<string, string[]>;
}

export interface YamlEnvironmentEditorHandle {
  save: () => Promise<void>;
}

interface YamlEnvironmentEditorProps {
  initialConfig?: EnvironmentConfig;
  initialYamlContent?: string;
  onSave: (
    config: EnvironmentConfig,
  ) => Promise<{ success: boolean; error?: string; warnings?: string[] }>;
  onChange?: () => void;
  onCancel: () => void;
  isSaving?: boolean;
  mode: 'create' | 'edit';
  hideActions?: boolean;
  warnings?: string[];
}

export const YamlEnvironmentEditor = forwardRef<
  YamlEnvironmentEditorHandle,
  YamlEnvironmentEditorProps
>(function YamlEnvironmentEditor(
  {
    initialConfig,
    initialYamlContent,
    onSave,
    onChange,
    onCancel,
    isSaving = false,
    mode,
    hideActions = false,
    warnings: externalWarnings,
  },
  ref,
) {
  const [yamlContent, setYamlContent] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [activeTab, setActiveTab] = useState<'editor' | 'yaml' | 'preview'>(
    mode === 'edit' ? 'editor' : 'yaml',
  );
  const [editorConfig, setEditorConfig] = useState<EnvironmentConfig | null>(
    initialConfig ?? null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hasUserEdited, setHasUserEdited] = useState(false);

  const repositories = useRepositories();
  const showLivePreviewSettings = true;

  const validate = useCallback((): ValidationResult => {
    try {
      const parsed = YAML.parse(yamlContent);

      if (!parsed || typeof parsed !== 'object') {
        return {
          success: false,
          errors: ['Invalid YAML: Must be an object'],
        };
      }

      const result = environmentConfigSchema.safeParse(parsed);

      if (!result.success) {
        const fieldErrors: Record<string, string[]> = {};
        const errors: string[] = [];

        for (const issue of result.error.issues) {
          const path = issue.path.join('.');

          if (path) {
            if (!fieldErrors[path]) {
              fieldErrors[path] = [];
            }

            fieldErrors[path].push(issue.message);
          } else {
            errors.push(issue.message);
          }
        }

        return {
          success: false,
          errors: errors.length > 0 ? errors : ['Validation failed'],
          fieldErrors,
        };
      }

      return { success: true, data: result.data };
    } catch (err) {
      return {
        success: false,
        errors: [
          err instanceof Error
            ? `YAML parse error: ${err.message}`
            : 'Invalid YAML',
        ],
      };
    }
  }, [yamlContent]);

  const handleTabChange = useCallback(
    (tab: string) => {
      if (tab === 'preview' || tab === 'editor') {
        const result = validate();
        setValidation(result);

        if (result.success) {
          setEditorConfig(result.data ?? null);
          setActiveTab(tab as 'editor' | 'preview');
        } else {
          setActiveTab('yaml');
        }
      } else {
        setActiveTab('yaml');
      }
    },
    [validate],
  );

  const handleSave = useCallback(async () => {
    const result = validate();
    setValidation(result);

    if (!result.success || !result.data) {
      setActiveTab('yaml');
      return;
    }

    setSaveError(null);
    const saveResult = await onSave(result.data);

    if (!saveResult.success) {
      setSaveError(saveResult.error || 'Failed to save environment');
    }
  }, [validate, onSave]);

  const handleYamlChange = useCallback(
    (value: string) => {
      setYamlContent(value);
      setHasUserEdited(true);

      if (validation) {
        setValidation(null);
      }

      if (saveError) {
        setSaveError(null);
      }

      onChange?.();
    },
    [onChange, saveError, validation],
  );

  const handleVisualChange = useCallback(
    (nextConfig: EnvironmentConfig) => {
      setEditorConfig(nextConfig);
      setYamlContent(configToYaml(nextConfig));
      setHasUserEdited(true);

      if (validation) {
        setValidation(null);
      }

      if (saveError) {
        setSaveError(null);
      }

      onChange?.();
    },
    [onChange, saveError, validation],
  );

  useEffect(() => {
    if (initialYamlContent === undefined) {
      return;
    }

    setYamlContent(initialYamlContent);
    setHasUserEdited(false);
    setValidation(null);
    setSaveError(null);
    setActiveTab('yaml');
  }, [initialYamlContent]);

  // Only reset content from the stored environment config if the user hasn't
  // made edits and no explicit YAML load is in progress.
  useEffect(() => {
    if (initialYamlContent !== undefined || hasUserEdited) return;

    if (initialConfig) {
      setYamlContent(configToYaml(initialConfig));
      setEditorConfig(initialConfig);
    } else if (repositories.data) {
      const repoNames = repositories.data.map((repo) => repo.fullName);
      setYamlContent(getDefaultYamlTemplate(repoNames));
      setEditorConfig(null);
    }
  }, [initialConfig, initialYamlContent, repositories.data, hasUserEdited]);

  useImperativeHandle(ref, () => ({
    save: handleSave,
  }));

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        {/* Tabs Header */}
        <div className="flex items-center justify-between">
          <TabsList>
            {mode === 'edit' ? (
              <TabsTrigger value="editor">
                <Settings2 className="size-4" />
                Editor
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="yaml">
              <FileCode className="size-4" />
              Yaml
            </TabsTrigger>
            <TabsTrigger value="preview">
              <Eye className="size-4" />
              Preview
            </TabsTrigger>
          </TabsList>

          {validation && (
            <Badge variant={validation.success ? 'default' : 'destructive'}>
              {validation.success ? (
                <span className="flex items-center gap-1">
                  <Check className="size-3" /> Valid
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <AlertCircle className="size-3" /> Invalid
                </span>
              )}
            </Badge>
          )}
        </div>

        {mode === 'edit' ? (
          <TabsContent value="editor" className="space-y-4">
            {editorConfig ? (
              <VisualEnvironmentEditor
                config={editorConfig}
                onChange={handleVisualChange}
                repositories={repositories.data ?? []}
                showLivePreviewSettings={showLivePreviewSettings}
              />
            ) : null}
          </TabsContent>
        ) : null}

        {/* YAML Tab */}
        <TabsContent value="yaml" className="space-y-4">
          <div className="relative">
            <Textarea
              value={yamlContent}
              onChange={(e) => handleYamlChange(e.target.value)}
              className={cn(
                'font-mono text-[13px] min-h-75 h-[calc(var(--effective-viewport-height)-40rem)] overflow-y-auto resize-none',
              )}
              placeholder="Enter environment configuration in YAML format..."
              spellCheck={false}
            />
          </div>

          {/* Validation Errors */}
          {validation && !validation.success && (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 space-y-2">
              <div className="flex items-center gap-2 text-destructive font-medium text-sm">
                <AlertCircle className="size-4" />
                {validation.errors && validation.errors.length === 1
                  ? validation.errors[0]
                  : 'Validation failed'}
              </div>
              {validation.errors && validation.errors.length > 1 && (
                <ul className="text-sm space-y-1 text-destructive/90 list-disc list-inside ml-2">
                  {validation.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              )}
              {validation.fieldErrors &&
                Object.keys(validation.fieldErrors).length > 0 && (
                  <ul className="text-sm space-y-1 text-destructive/90 list-disc list-inside ml-2">
                    {Object.entries(validation.fieldErrors).map(
                      ([field, errors]) => (
                        <li key={field}>
                          <span className="font-mono text-xs">
                            {field || 'root'}
                          </span>
                          : {errors.join(', ')}
                        </li>
                      ),
                    )}
                  </ul>
                )}
            </div>
          )}
        </TabsContent>

        {/* Preview Tab */}
        <TabsContent value="preview">
          {validation?.data ? (
            <EnvironmentPreviewContent
              config={validation.data}
              showLivePreviewSettings={showLivePreviewSettings}
            />
          ) : (
            <div className="text-center text-muted-foreground py-8">
              No valid configuration to preview.
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Save Error */}
      {saveError && (
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
          <div className="flex items-center gap-2 text-destructive font-medium text-sm">
            <AlertCircle className="size-4" />
            {saveError}
          </div>
        </div>
      )}

      {/* Warnings */}
      {externalWarnings && externalWarnings.length > 0 && (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertDescription>
            <div className="space-y-1">
              {externalWarnings.length === 1 ? (
                <p>{externalWarnings[0]}</p>
              ) : (
                <ul className="list-disc list-inside space-y-1">
                  {externalWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Actions */}
      {!hideActions && (
        <div className="flex justify-end items-center gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving
              ? mode === 'create'
                ? 'Creating...'
                : 'Saving...'
              : mode === 'create'
                ? 'Create Environment'
                : 'Save Changes'}
          </Button>
        </div>
      )}
    </div>
  );
});
