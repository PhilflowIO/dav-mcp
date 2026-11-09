#!/usr/bin/env node
/**
 * Put a published dav-mcp release into the Claude plugin (claude-plugin/).
 *
 * The plugin carries the server's readable source and a lockfile instead of
 * downloading the package at start (`npx -y dav-mcp@<version>`): the Claude
 * directory's scan cannot read a package that npm fetches on the user's
 * machine, and held every version as "not fully checked" (#149). Now:
 *
 *   - claude-plugin/src/ is the `src/` of the dav-mcp tarball that npm serves
 *     for the version, byte for byte, so the plugin runs exactly what was
 *     published with provenance, and the directory can read all of it.
 *   - claude-plugin/package.json declares that release's runtime
 *     dependencies, and claude-plugin/package-lock.json pins them with
 *     registry URLs and hashes. Claude Code installs them itself, with
 *     `npm ci --ignore-scripts`, when it copies the plugin into its cache.
 *   - claude-plugin/.mcp.json starts `node ${CLAUDE_PLUGIN_ROOT}/src/server-stdio.js`.
 *
 * The version is taken from package.json. Run this after the release workflow
 * has published that version to npm, not in the release pull request
 * (CONTRIBUTING.md, Releases): it reads the published tarball, so it fails for
 * a version that is not on npm yet. __tests__/claude-plugin.test.js checks the
 * files are consistent; the `claude-plugin` CI job checks that src/ equals the
 * published tarball and that the plugin installs and starts.
 *
 * Usage: npm run plugin:sync
 */

import { execFileSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const root = new URL('../', import.meta.url);
export const pluginDir = fileURLToPath(new URL('claude-plugin/', root));
export const pluginJsonPath = join(pluginDir, '.claude-plugin', 'plugin.json');
export const mcpJsonPath = join(pluginDir, '.mcp.json');
export const pluginPackagePath = join(pluginDir, 'package.json');
export const pluginLockPath = join(pluginDir, 'package-lock.json');
export const pluginSrcDir = join(pluginDir, 'src');

/** The registry every locked package must come from. */
export const REGISTRY = 'https://registry.npmjs.org/';

/** How .mcp.json starts the server, relative to the plugin's install directory. */
export const SERVER_ENTRY = '${CLAUDE_PLUGIN_ROOT}/src/server-stdio.js';

const packageVersion = () =>
  JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;

/**
 * plugin.json with its version set.
 *
 * @param {Object} plugin - Parsed plugin.json
 * @param {string} [version] - Defaults to the package.json version
 * @returns {Object}
 */
export function syncedPlugin(plugin, version = packageVersion()) {
  return { ...plugin, version };
}

/**
 * The plugin's package.json, derived from the published package.json of the
 * release it carries.
 *
 * Only what Node and the dependency install read: `name` and `version`
 * (src/server-info.js reports them to MCP clients), `type` (src/ is ES
 * modules), `engines` and the runtime `dependencies`. No scripts, no `bin`, no
 * `overrides`: Claude Code installs nothing from a package.json that sets
 * overrides.
 *
 * @param {Object} published - package.json from the dav-mcp tarball
 * @returns {Object}
 */
export function pluginPackageJson(published) {
  return {
    name: published.name,
    version: published.version,
    private: true,
    description: 'Dependencies of the dav-mcp server inside the Claude plugin. Written by `npm run plugin:sync`; do not edit.',
    license: published.license,
    type: published.type,
    engines: published.engines,
    dependencies: published.dependencies,
  };
}

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Compare two `x.y.z` or `x.y.z-pre` versions by semver precedence.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b, 0 when equal, positive when a > b
 */
export function compareVersions(a, b) {
  const pa = a.match(RELEASE_VERSION);
  const pb = b.match(RELEASE_VERSION);
  if (!pa || !pb) throw new Error(`not a release version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  // A version without a prerelease ranks above any prerelease of it.
  if (!pa[4] || !pb[4]) return (pa[4] ? -1 : 0) + (pb[4] ? 1 : 0);
  const ia = pa[4].split('.');
  const ib = pb[4].split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb) {
      const diff = Number(ia[i]) - Number(ib[i]);
      if (diff !== 0) return diff;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (ia[i] !== ib[i]) {
      return ia[i] < ib[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * A JSON file as this script writes it.
 *
 * @param {Object} value
 * @returns {string}
 */
export function serializeJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

// npm with the public registry and none of the user's npm config: a scoped
// registry or auth line in ~/.npmrc (which --registry does not override)
// would otherwise change where packages are locked from.
const npm = (args, cwd, emptyConfig) => execFileSync('npm', [
  ...args, `--registry=${REGISTRY}`, `--userconfig=${emptyConfig}`, '--ignore-scripts', '--no-audit', '--no-fund',
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/**
 * Download and unpack the published tarball of dav-mcp@<version>.
 * npm checks it against the registry's integrity hash.
 *
 * @param {string} version
 * @param {string} workDir
 * @param {string} emptyConfig - an empty npmrc, see `npm` above
 * @returns {string} the unpacked package directory
 */
export function fetchRelease(version, workDir, emptyConfig) {
  const [{ filename }] = JSON.parse(npm(['pack', `dav-mcp@${version}`, '--json', '--pack-destination', workDir], workDir, emptyConfig));
  execFileSync('tar', ['-xzf', join(workDir, filename), '-C', workDir]);
  return join(workDir, 'package');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = packageVersion();
  // A prerelease goes to the dist-tag `next`; the plugin carries only what
  // `latest` serves (CONTRIBUTING.md, Releases).
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`package.json has ${version}; the plugin carries stable releases only`);
    process.exit(1);
  }

  // Everything is built in a work directory and only moved into
  // claude-plugin/ once npm has succeeded, so a failed run leaves the plugin
  // as it was.
  const work = mkdtempSync(join(tmpdir(), 'dav-mcp-plugin-sync-'));
  try {
    const emptyConfig = join(work, 'npmrc');
    writeFileSync(emptyConfig, '');
    const release = fetchRelease(version, work, emptyConfig);
    const published = JSON.parse(readFileSync(join(release, 'package.json'), 'utf8'));

    const staged = join(work, 'staged');
    mkdirSync(staged);
    writeFileSync(join(staged, 'package.json'), serializeJson(pluginPackageJson(published)));
    npm(['install', '--package-lock-only'], staged, emptyConfig);

    const plugin = syncedPlugin(JSON.parse(readFileSync(pluginJsonPath, 'utf8')), version);

    rmSync(pluginSrcDir, { recursive: true, force: true });
    cpSync(join(release, 'src'), pluginSrcDir, { recursive: true });
    cpSync(join(staged, 'package.json'), pluginPackagePath);
    cpSync(join(staged, 'package-lock.json'), pluginLockPath);
    writeFileSync(pluginJsonPath, serializeJson(plugin));

    const locked = Object.keys(JSON.parse(readFileSync(pluginLockPath, 'utf8')).packages).length - 1;
    console.log(`claude-plugin: dav-mcp ${version} source, ${locked} locked packages`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
