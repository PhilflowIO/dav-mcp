/**
 * The Claude plugin (claude-plugin/) as the Claude directory checks it.
 *
 * `claude plugin validate` covers the manifest schema; these tests cover what
 * it does not: the launcher is pinned to an exact release no newer than
 * package.json (it trails package.json until that version is on npm),
 * the credentials the server needs are asked for with the right flags, and
 * the folder holds only what the directory accepts without a hold.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import {
  pluginJsonPath, mcpJsonPath, syncedPlugin, syncedMcpConfig, serializeJson, compareVersions,
} from '../scripts/sync-claude-plugin.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginDir = join(root, 'claude-plugin');
const read = (file) => readFileSync(join(root, file), 'utf8');

const pluginText = readFileSync(pluginJsonPath, 'utf8');
const mcpText = readFileSync(mcpJsonPath, 'utf8');
const plugin = JSON.parse(pluginText);
const server = JSON.parse(mcpText).mcpServers['dav-mcp'];
const packageJson = JSON.parse(read('package.json'));
const [npmPackage] = JSON.parse(read('server.json')).packages;
const declaredEnv = new Map(npmPackage.environmentVariables.map(v => [v.name, v]));

// "${user_config.password}" -> "password"
const userConfigKey = (value) => value.match(/^\$\{user_config\.([a-z_]+)\}$/)?.[1];

const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? filesIn(path) : [path];
});
const pluginFiles = filesIn(pluginDir).map(path => relative(pluginDir, path));

describe('Claude plugin version', () => {
  test('plugin.json and .mcp.json are formatted the way scripts/sync-claude-plugin.js writes them', () => {
    // On failure run `npm run plugin:sync` once the version is on npm.
    expect(pluginText).toBe(serializeJson(plugin));
    expect(mcpText).toBe(serializeJson(JSON.parse(mcpText)));
  });

  test('scripts/sync-claude-plugin.js pins both files to the package.json version', () => {
    const synced = syncedMcpConfig(JSON.parse(mcpText)).mcpServers['dav-mcp'];
    expect(syncedPlugin(plugin).version).toBe(packageJson.version);
    expect(synced.args).toEqual(['-y', `${packageJson.name}@${packageJson.version}`]);
    expect(synced.env).toEqual(server.env);
  });

  // The pin trails package.json between a release pull request and the
  // publish (CONTRIBUTING.md, Releases); `plugin-pin` in CI checks that the
  // pinned version is on npm.
  test('starts the npm package pinned to an exact release no newer than package.json', () => {
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', `${packageJson.name}@${plugin.version}`]);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(compareVersions(plugin.version, packageJson.version)).toBeLessThanOrEqual(0);
  });
});

describe('compareVersions', () => {
  test.each([
    ['4.3.0', '4.3.1', -1],
    ['4.3.1', '4.3.1', 0],
    ['4.10.0', '4.9.9', 1],
    ['5.0.0-rc.1', '5.0.0', -1],
    ['5.0.0-rc.2', '5.0.0-rc.10', -1],
    ['5.0.0-alpha', '5.0.0-alpha.1', -1],
    ['5.0.0-1', '5.0.0-alpha', -1],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
    expect(Math.sign(compareVersions(b, a))).toBe(0 - sign);
  });

  test('refuses build metadata and partial versions', () => {
    expect(() => compareVersions('4.3.1+build.1', '4.3.1')).toThrow('not a release version');
    expect(() => compareVersions('4.3', '4.3.1')).toThrow('not a release version');
  });
});

describe('Claude plugin configuration', () => {
  test('passes only environment variables that server.json declares', () => {
    const undeclared = Object.keys(server.env).filter(name => !declaredEnv.has(name));
    expect(undeclared).toEqual([]);
  });

  test('fills every environment variable from a user setting with the same required/secret flags', () => {
    for (const [name, value] of Object.entries(server.env)) {
      const key = userConfigKey(value);
      expect({ name, key }).toEqual({ name, key: expect.any(String) });

      const setting = plugin.userConfig[key];
      const declared = declaredEnv.get(name);
      expect({ name, required: setting.required === true }).toEqual({ name, required: declared.isRequired });
      expect({ name, sensitive: setting.sensitive === true }).toEqual({ name, sensitive: declared.isSecret });
    }
  });

  test('asks only for settings it passes to the server', () => {
    const used = Object.values(server.env).map(userConfigKey);
    expect(Object.keys(plugin.userConfig).sort()).toEqual([...used].sort());
  });

  test('links listing pages over https', () => {
    for (const field of ['homepage', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl']) {
      expect({ field, url: plugin[field] }).toEqual({ field, url: expect.stringMatching(/^https:\/\//) });
    }
  });
});

describe('Claude plugin folder', () => {
  test('has a README of at least 40 words outside code blocks, and the license', () => {
    const prose = readFileSync(join(pluginDir, 'README.md'), 'utf8').replace(/```[\s\S]*?```/g, '');
    expect(prose.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    expect(readFileSync(join(pluginDir, 'LICENSE'), 'utf8')).toBe(read('LICENSE'));
  });

  test('holds only text and images under 256 KiB, no package-manager files', () => {
    for (const file of pluginFiles) {
      expect({ file, ok: /\.(md|json|png|svg)$|(^|\/)LICENSE$/.test(file) }).toEqual({ file, ok: true });
      expect({ file, ok: statSync(join(pluginDir, file)).size < 256 * 1024 }).toEqual({ file, ok: true });
    }
    // a launcher next to a registry config or lockfile blocks the submission
    const forbidden = pluginFiles.filter(f => /(^|\/)(\.npmrc|package(-lock)?\.json|npm-shrinkwrap\.json|bun\.lockb?|\.DS_Store)$/.test(f));
    expect(forbidden).toEqual([]);
  });

  test('every skill has front matter with a name and a one-line description', () => {
    const skills = pluginFiles.filter(f => f.endsWith('/SKILL.md'));
    expect(skills.length).toBeGreaterThan(0);
    for (const file of skills) {
      const [, frontMatter] = readFileSync(join(pluginDir, file), 'utf8').match(/^---\n([\s\S]*?)\n---\n/) ?? [];
      expect({ file, frontMatter: typeof frontMatter }).toEqual({ file, frontMatter: 'string' });
      expect(frontMatter).toMatch(/^name: [a-z0-9-]+$/m);
      expect(frontMatter).toMatch(/^description: \S.+$/m);
    }
  });
});
