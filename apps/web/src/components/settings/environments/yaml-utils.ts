import YAML from 'yaml';

import {
  type EnvironmentConfig,
  COMMAND_DEFAULT_TIMEOUT,
} from '@roomote/types';

/**
 * Converts an EnvironmentConfig object to a well-formatted YAML string.
 */
export function configToYaml(config: EnvironmentConfig): string {
  // Create a clean object for YAML output, omitting undefined/empty values.
  const cleanConfig: Record<string, unknown> = {
    name: config.name,
  };

  if (config.description) {
    cleanConfig.description = config.description;
  }

  if (config.initialUrl) {
    cleanConfig.initialUrl = config.initialUrl;
  }

  if (config.agentInstructions) {
    cleanConfig.agentInstructions = config.agentInstructions;
  }

  if (config.tool_versions && Object.keys(config.tool_versions).length > 0) {
    cleanConfig.tool_versions = config.tool_versions;
  }

  if (config.repositories && config.repositories.length > 0) {
    cleanConfig.repositories = config.repositories.map((repo) => {
      const cleanRepo: Record<string, unknown> = {
        repository: repo.repository,
      };

      if (repo.branch) {
        cleanRepo.branch = repo.branch;
      }

      if (repo.tool_versions && Object.keys(repo.tool_versions).length > 0) {
        cleanRepo.tool_versions = repo.tool_versions;
      }

      if (repo.commands && repo.commands.length > 0) {
        cleanRepo.commands = repo.commands.map((cmd) => {
          const cleanCmd: Record<string, unknown> = {
            name: cmd.name,
            run: cmd.run,
          };

          if (cmd.env && Object.keys(cmd.env).length > 0) {
            cleanCmd.env = cmd.env;
          }

          if (cmd.working_dir) {
            cleanCmd.working_dir = cmd.working_dir;
          }

          if (cmd.cwd) {
            cleanCmd.cwd = cmd.cwd;
          }

          if (cmd.timeout && cmd.timeout !== COMMAND_DEFAULT_TIMEOUT) {
            cleanCmd.timeout = cmd.timeout;
          }

          if (cmd.continue_on_error) {
            cleanCmd.continue_on_error = cmd.continue_on_error;
          }

          if (cmd.detached) {
            cleanCmd.detached = cmd.detached;
          }

          if (cmd.logfile) {
            cleanCmd.logfile = cmd.logfile;
          }

          return cleanCmd;
        });
      }

      return cleanRepo;
    });
  }

  if (config.services && config.services.length > 0) {
    cleanConfig.services = config.services;
  }

  if (config.oidc) {
    cleanConfig.oidc = config.oidc;
  }

  if (config.ports && config.ports.length > 0) {
    cleanConfig.ports = config.ports;
  }

  if (config.skills && Object.keys(config.skills).length > 0) {
    cleanConfig.skills = config.skills;
  }

  if (config.manualSkills && config.manualSkills.length > 0) {
    cleanConfig.manualSkills = config.manualSkills;
  }

  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    cleanConfig.mcpServers = config.mcpServers;
  }

  if (config.env && Object.keys(config.env).length > 0) {
    cleanConfig.env = config.env;
  }

  if (config.auth_bypass_header !== undefined) {
    cleanConfig.auth_bypass_header = config.auth_bypass_header;
  }

  if (config.auth_bypass_header_name !== undefined) {
    cleanConfig.auth_bypass_header_name = config.auth_bypass_header_name;
  }

  return YAML.stringify(cleanConfig, { indent: 2, lineWidth: 0 });
}
