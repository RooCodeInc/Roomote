export interface CurrentMcpConfig {
  enabledIntegrationIds?: string[];
  configuredCustomServerIds?: string[];
  configuredWorkspaceServerIds?: string[];
}

export type McpRecommendationCategory =
  | 'built_in_integration'
  | 'org_integration';

export interface McpRecommendation {
  id: string;
  name: string;
  category: McpRecommendationCategory;
  description: string;
  capabilities: string[];
  setupLocation: string;
  priority: 'high' | 'medium' | 'low';
  rationale: string;
}
