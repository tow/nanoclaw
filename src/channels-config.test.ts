import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadChannelsConfig, channelToGroup } from './channels-config.js';

vi.mock('fs');
vi.mock('os');

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

beforeEach(() => {
  vi.clearAllMocks();
  mockOs.homedir.mockReturnValue('/home/testuser');
  // Default: no config files exist
  mockFs.existsSync.mockReturnValue(false);
  delete process.env.NANOCLAW_CHANNELS_CONFIG;
});

const VALID_CONFIG = `
repos:
  prospecting:
    path: /opt/nanoclaw/prospecting
    allowedTools:
      - "Bash(git *)"
      - "Read"
      - "Glob"

channels:
  slack:C0ABC123:
    name: crm-inbox
    repo: prospecting
  slack:C0DEF456:
    name: general
    repo: prospecting
    trigger: "@rex"
`;

describe('loadChannelsConfig', () => {
  it('returns null when no config file exists', () => {
    const result = loadChannelsConfig();
    expect(result).toBeNull();
  });

  it('loads config from NANOCLAW_CHANNELS_CONFIG env var', () => {
    process.env.NANOCLAW_CHANNELS_CONFIG = '/custom/path/channels.yaml';
    mockFs.existsSync.mockImplementation(
      (p) => p === '/custom/path/channels.yaml',
    );
    mockFs.readFileSync.mockReturnValue(VALID_CONFIG);

    const result = loadChannelsConfig();
    expect(result).not.toBeNull();
    expect(result!.repos.prospecting.path).toBe('/opt/nanoclaw/prospecting');
    expect(result!.channels['slack:C0ABC123'].name).toBe('crm-inbox');
  });

  it('loads config from ~/.config/nanoclaw/channels.yaml', () => {
    mockFs.existsSync.mockImplementation(
      (p) => p === '/home/testuser/.config/nanoclaw/channels.yaml',
    );
    mockFs.readFileSync.mockReturnValue(VALID_CONFIG);

    const result = loadChannelsConfig();
    expect(result).not.toBeNull();
    expect(Object.keys(result!.channels)).toHaveLength(2);
  });

  it('parses dedicated channel (no trigger)', () => {
    process.env.NANOCLAW_CHANNELS_CONFIG = '/config.yaml';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(VALID_CONFIG);

    const result = loadChannelsConfig();
    const inbox = result!.channels['slack:C0ABC123'];
    expect(inbox.trigger).toBeUndefined();
  });

  it('parses triggered channel', () => {
    process.env.NANOCLAW_CHANNELS_CONFIG = '/config.yaml';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(VALID_CONFIG);

    const result = loadChannelsConfig();
    const general = result!.channels['slack:C0DEF456'];
    expect(general.trigger).toBe('@rex');
  });

  it('returns null when channel references unknown repo', () => {
    process.env.NANOCLAW_CHANNELS_CONFIG = '/config.yaml';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(`
repos:
  prospecting:
    path: /opt/repos/prospecting
    allowedTools: ["Read"]
channels:
  slack:C123:
    name: test
    repo: nonexistent
`);

    const result = loadChannelsConfig();
    expect(result).toBeNull();
  });

  it('returns null when repos section is missing', () => {
    process.env.NANOCLAW_CHANNELS_CONFIG = '/config.yaml';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(`
channels:
  slack:C123:
    name: test
    repo: something
`);

    const result = loadChannelsConfig();
    expect(result).toBeNull();
  });

  it('returns null when channel is missing name', () => {
    process.env.NANOCLAW_CHANNELS_CONFIG = '/config.yaml';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(`
repos:
  prospecting:
    path: /opt/repos/prospecting
    allowedTools: ["Read"]
channels:
  slack:C123:
    repo: prospecting
`);

    const result = loadChannelsConfig();
    expect(result).toBeNull();
  });

  it('warns but continues when repo path does not exist', () => {
    process.env.NANOCLAW_CHANNELS_CONFIG = '/config.yaml';
    // Config file exists, but repo path does not
    mockFs.existsSync.mockImplementation((p) => p === '/config.yaml');
    mockFs.readFileSync.mockReturnValue(VALID_CONFIG);

    const result = loadChannelsConfig();
    // Should still load successfully (warning only)
    expect(result).not.toBeNull();
  });
});

describe('channelToGroup', () => {
  it('converts dedicated channel to group with requiresTrigger=false', () => {
    const group = channelToGroup(
      'slack:C123',
      { name: 'crm-inbox', repo: 'prospecting' },
      { path: '/opt/repos/prospecting', allowedTools: ['Read', 'Glob'] },
    );

    expect(group.name).toBe('crm-inbox');
    expect(group.folder).toBe('slack_crm-inbox');
    expect(group.requiresTrigger).toBe(false);
    expect(group.trigger).toBe('');
    expect(group.containerConfig?.projectPath).toBe('/opt/repos/prospecting');
    expect(group.containerConfig?.allowedTools).toEqual(['Read', 'Glob']);
  });

  it('converts triggered channel to group with requiresTrigger=true', () => {
    const group = channelToGroup(
      'slack:C456',
      { name: 'general', repo: 'prospecting', trigger: '@rex' },
      { path: '/opt/repos/prospecting', allowedTools: ['Read'] },
    );

    expect(group.requiresTrigger).toBe(true);
    expect(group.trigger).toBe('@rex');
  });

  it('sanitizes channel name for folder', () => {
    const group = channelToGroup(
      'slack:C789',
      { name: 'my channel (test)', repo: 'test' },
      { path: '/tmp/test', allowedTools: [] },
    );

    expect(group.folder).toBe('slack_my-channel--test-');
  });
});
