import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { syncedManifest, serializeManifest } from '../scripts/sync-mcpb-manifest.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const manifestText = read('manifest.json');
const manifest = JSON.parse(manifestText);
const packageJson = JSON.parse(read('package.json'));
const serverJson = JSON.parse(read('server.json'));

// server.json is the registry's description of the configuration and owns
// every environment variable; the bundle may expose a subset, never more.
const [npmPackage] = serverJson.packages;
const declaredEnv = new Map(npmPackage.environmentVariables.map(v => [v.name, v]));

// "${user_config.password}" -> "password"
const userConfigKey = (value) => value.match(/^\$\{user_config\.([a-z_]+)\}$/)?.[1];

describe('MCP Bundle manifest (manifest.json)', () => {
  test('has the version and tool list that scripts/sync-mcpb-manifest.js writes', () => {
    // On failure run `npm run mcpb:sync` and commit manifest.json.
    expect(manifestText).toBe(serializeManifest(syncedManifest(manifest)));
  });

  test('version matches package.json and server.json', () => {
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.version).toBe(serverJson.version);
    expect(manifest.version).toBe(npmPackage.version);
  });

  test('starts the stdio server that package.json publishes as its bin', () => {
    expect(manifest.server.entry_point).toBe(packageJson.bin['dav-mcp']);
    expect(manifest.server.mcp_config.args).toEqual([`\${__dirname}/${manifest.server.entry_point}`]);
  });

  test('requires the Node.js versions package.json supports', () => {
    expect(manifest.compatibility.runtimes.node).toBe(packageJson.engines.node);
  });

  test('passes only environment variables that server.json declares', () => {
    const undeclared = Object.keys(manifest.server.mcp_config.env).filter(name => !declaredEnv.has(name));
    expect(undeclared).toEqual([]);
  });

  test('fills every environment variable from a user setting with the same required/secret flags', () => {
    for (const [name, value] of Object.entries(manifest.server.mcp_config.env)) {
      const key = userConfigKey(value);
      expect({ name, key }).toEqual({ name, key: expect.any(String) });

      const setting = manifest.user_config[key];
      const declared = declaredEnv.get(name);
      expect({ name, required: setting.required === true }).toEqual({ name, required: declared.isRequired });
      expect({ name, sensitive: setting.sensitive === true }).toEqual({ name, sensitive: declared.isSecret });
    }
  });

  test('asks only for settings it passes to the server', () => {
    const used = Object.values(manifest.server.mcp_config.env).map(userConfigKey);
    expect(Object.keys(manifest.user_config).sort()).toEqual([...used].sort());
  });
});
