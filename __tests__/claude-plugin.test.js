/**
 * The Claude plugin (claude-plugin/) as the Claude directory checks it.
 *
 * `claude plugin validate` covers the manifest schema; these tests cover what
 * it does not: the plugin carries one release (no newer than package.json; it
 * trails package.json until that version is on npm) consistently in every
 * file, its lockfile installs the way Claude Code installs it, the
 * credentials the server needs are asked for with the right flags, and the
 * folder holds only what the directory can read.
 *
 * That claude-plugin/src/ is the published tarball's src/ needs the network;
 * the `claude-plugin` job in test.yml checks it.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import {
  pluginJsonPath, mcpJsonPath, pluginPackagePath, pluginLockPath, pluginSrcDir,
  REGISTRY, SERVER_ENTRY, syncedPlugin, pluginPackageJson, serializeJson, compareVersions,
} from '../scripts/sync-claude-plugin.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginDir = join(root, 'claude-plugin');
const read = (file) => readFileSync(join(root, file), 'utf8');

const pluginText = readFileSync(pluginJsonPath, 'utf8');
const mcpText = readFileSync(mcpJsonPath, 'utf8');
const plugin = JSON.parse(pluginText);
const server = JSON.parse(mcpText).mcpServers['dav-mcp'];
const packageJson = JSON.parse(read('package.json'));
const pluginPackageText = readFileSync(pluginPackagePath, 'utf8');
const pluginPackage = JSON.parse(pluginPackageText);
const lock = JSON.parse(readFileSync(pluginLockPath, 'utf8'));
const lockedPackages = Object.entries(lock.packages).filter(([path]) => path !== '');
const [npmPackage] = JSON.parse(read('server.json')).packages;
const declaredEnv = new Map(npmPackage.environmentVariables.map(v => [v.name, v]));

// "${user_config.password}" -> "password"
const userConfigKey = (value) => value.match(/^\$\{user_config\.([a-z_]+)\}$/)?.[1];

const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? filesIn(path) : [path];
});
// evals/results/ is what `claude plugin eval` writes on a local run (HTML
// report, JSON), node_modules/ what a local `npm ci` in the folder writes;
// both are gitignored and never part of the plugin. The eval cases and mocks
// themselves are checked like every other plugin file.
const pluginFiles = filesIn(pluginDir)
  .map(path => relative(pluginDir, path))
  .filter(file => !file.startsWith('evals/results/') && !file.startsWith('node_modules/'));

describe('Claude plugin version', () => {
  test('plugin.json, .mcp.json and package.json are formatted the way scripts/sync-claude-plugin.js writes them', () => {
    // On failure run `npm run plugin:sync` once the version is on npm.
    expect(pluginText).toBe(serializeJson(plugin));
    expect(mcpText).toBe(serializeJson(JSON.parse(mcpText)));
    expect(pluginPackageText).toBe(serializeJson(pluginPackageJson(pluginPackage)));
  });

  test('scripts/sync-claude-plugin.js writes the package.json version by default', () => {
    expect(syncedPlugin(plugin).version).toBe(packageJson.version);
    expect(syncedPlugin(plugin, '1.2.3').version).toBe('1.2.3');
  });

  // The plugin trails package.json between a release pull request and the
  // publish (CONTRIBUTING.md, Releases).
  test('carries one exact release, no newer than package.json, in plugin.json, package.json and the lockfile', () => {
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(compareVersions(plugin.version, packageJson.version)).toBeLessThanOrEqual(0);
    expect({ name: pluginPackage.name, version: pluginPackage.version })
      .toEqual({ name: packageJson.name, version: plugin.version });
    expect({ name: lock.name, version: lock.version, root: lock.packages[''].version })
      .toEqual({ name: packageJson.name, version: plugin.version, root: plugin.version });
  });
});

describe('Claude plugin server', () => {
  // A file in the plugin started with plain arguments: the directory reads
  // that form, and a package launcher (npx) is held as unreadable.
  test('starts the bundled source with node', () => {
    expect(server.command).toBe('node');
    expect(server.args).toEqual([SERVER_ENTRY]);
    const entry = SERVER_ENTRY.replace('${CLAUDE_PLUGIN_ROOT}', pluginDir);
    expect(statSync(entry).isFile()).toBe(true);
  });

  test('declares the runtime dependencies of the release and nothing that runs at install', () => {
    expect(pluginPackage.private).toBe(true);
    expect(pluginPackage.type).toBe('module');
    // Claude Code installs nothing for a package.json with overrides.
    for (const field of ['scripts', 'overrides', 'bin', 'bundleDependencies', 'devDependencies']) {
      expect({ field, present: field in pluginPackage }).toEqual({ field, present: false });
    }
  });

  // What Claude Code accepts for its automatic `npm ci --ignore-scripts`
  // (code.claude.com/docs/en/plugins/loading, Node.js package dependencies).
  test('locks every dependency to an exact registry download with a hash', () => {
    expect([2, 3]).toContain(lock.lockfileVersion);
    expect(lock.packages[''].dependencies).toEqual(pluginPackage.dependencies);
    expect(lockedPackages.length).toBeGreaterThan(0);
    for (const [path, meta] of lockedPackages) {
      expect({ path, link: meta.link === true }).toEqual({ path, link: false });
      expect({ path, version: meta.version }).toEqual({ path, version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
      expect({ path, resolved: meta.resolved }).toEqual({ path, resolved: expect.stringMatching(new RegExp(`^${REGISTRY}`)) });
      expect({ path, integrity: meta.integrity }).toEqual({ path, integrity: expect.stringMatching(/^sha512-/) });
    }
  });

  // --ignore-scripts skips install scripts; a dependency that needs one would
  // install but not work.
  test('needs no install scripts and no dev dependencies', () => {
    expect(lockedPackages.filter(([, meta]) => meta.hasInstallScript).map(([path]) => path)).toEqual([]);
    expect(lockedPackages.filter(([, meta]) => meta.dev).map(([path]) => path)).toEqual([]);
  });

  test('bundles the source of every module the server imports', () => {
    const bundled = filesIn(pluginSrcDir).map(path => relative(pluginSrcDir, path));
    expect(bundled).toContain('server-stdio.js');
    for (const file of bundled.filter(f => f.endsWith('.js'))) {
      const source = readFileSync(join(pluginSrcDir, file), 'utf8');
      for (const [, specifier] of source.matchAll(/(?:\bfrom|\bimport\(?)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = relative(pluginSrcDir, join(pluginSrcDir, file, '..', specifier));
        expect({ file, specifier, bundled: bundled.includes(target) }).toEqual({ file, specifier, bundled: true });
      }
    }
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

  // The Claude directory blocks a submission whose settings offer a choice
  // list: it cannot screen the listed values. Settings stay free text, and the
  // server rejects values it does not know (see auth-config.js).
  test('offers no choice lists, which the Claude directory blocks', () => {
    const withOptions = Object.keys(plugin.userConfig).filter(key => 'options' in plugin.userConfig[key]);
    expect(withOptions).toEqual([]);
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

  // Past either limit the directory does not read the files and holds the
  // version (pre-submission checklist, Files in the plugin folder).
  test('holds at most 512 files, only readable text and images under 256 KiB', () => {
    expect(pluginFiles.length).toBeLessThanOrEqual(512);
    for (const file of pluginFiles) {
      expect({ file, ok: /\.(md|json|js|png|svg)$|(^|\/)LICENSE$/.test(file) }).toEqual({ file, ok: true });
      expect({ file, ok: statSync(join(pluginDir, file)).size < 256 * 1024 }).toEqual({ file, ok: true });
    }
  });

  // One npm lockfile at the plugin root and nothing that could change where
  // packages come from: a registry config next to an install is held, and
  // Claude Code picks bun.lock or npm-shrinkwrap.json over package-lock.json.
  test('installs only from package.json and package-lock.json at its root', () => {
    const packageFiles = pluginFiles.filter(f => /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.yarnrc(\.yml)?|bunfig\.toml)$/.test(f));
    expect(packageFiles.sort()).toEqual(['package-lock.json', 'package.json']);
    expect(pluginFiles.filter(f => /(^|\/)\.DS_Store$/.test(f))).toEqual([]);
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
