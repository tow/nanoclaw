/**
 * Channel configuration loader.
 *
 * Reads a YAML file that maps repos (path + allowed tools) to
 * Slack channels (routing + trigger). This config lives outside
 * the container and is not editable by agents.
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import os from 'os';

import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface RepoConfig {
  path: string;
  allowedTools: string[];
}

export interface ChannelConfig {
  name: string;
  repo: string;
  trigger?: string;
}

export interface ChannelsConfig {
  repos: Record<string, RepoConfig>;
  channels: Record<string, ChannelConfig>;
}

const CONFIG_PATHS = [
  process.env.NANOCLAW_CHANNELS_CONFIG,
  path.join(os.homedir(), '.config', 'nanoclaw', 'channels.yaml'),
  path.join(process.cwd(), 'channels.yaml'),
];

/**
 * Load and validate the channels config file.
 * Returns null if no config file is found.
 */
export function loadChannelsConfig(): ChannelsConfig | null {
  const configPath = CONFIG_PATHS.find((p) => p && fs.existsSync(p));
  if (!configPath) {
    logger.info('No channels.yaml found, using dynamic registration only');
    return null;
  }

  logger.info({ path: configPath }, 'Loading channels config');

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw) as ChannelsConfig;

  // Validate
  if (!parsed.repos || typeof parsed.repos !== 'object') {
    logger.error({ path: configPath }, 'channels.yaml: missing or invalid "repos" section');
    return null;
  }

  if (!parsed.channels || typeof parsed.channels !== 'object') {
    logger.error({ path: configPath }, 'channels.yaml: missing or invalid "channels" section');
    return null;
  }

  for (const [name, repo] of Object.entries(parsed.repos)) {
    if (!repo.path) {
      logger.error({ repo: name }, 'channels.yaml: repo missing "path"');
      return null;
    }
    if (!fs.existsSync(repo.path)) {
      logger.warn({ repo: name, path: repo.path }, 'channels.yaml: repo path does not exist');
    }
    if (!repo.allowedTools || !Array.isArray(repo.allowedTools)) {
      logger.warn({ repo: name }, 'channels.yaml: repo has no allowedTools, will use restrictive defaults');
      repo.allowedTools = [];
    }
  }

  for (const [jid, channel] of Object.entries(parsed.channels)) {
    if (!channel.name) {
      logger.error({ jid }, 'channels.yaml: channel missing "name"');
      return null;
    }
    if (!channel.repo) {
      logger.error({ jid }, 'channels.yaml: channel missing "repo"');
      return null;
    }
    if (!parsed.repos[channel.repo]) {
      logger.error(
        { jid, repo: channel.repo },
        'channels.yaml: channel references unknown repo',
      );
      return null;
    }
  }

  logger.info(
    { repos: Object.keys(parsed.repos).length, channels: Object.keys(parsed.channels).length },
    'Channels config loaded',
  );

  return parsed;
}

/**
 * Convert a channel config entry into a RegisteredGroup.
 */
export function channelToGroup(
  jid: string,
  channel: ChannelConfig,
  repo: RepoConfig,
): RegisteredGroup {
  // Folder name derived from channel name (safe for filesystem)
  const folder = `slack_${channel.name.replace(/[^a-zA-Z0-9-]/g, '-')}`;

  return {
    name: channel.name,
    folder,
    trigger: channel.trigger || '',
    added_at: new Date().toISOString(),
    requiresTrigger: !!channel.trigger,
    containerConfig: {
      projectPath: repo.path,
      allowedTools: repo.allowedTools,
    },
  };
}
