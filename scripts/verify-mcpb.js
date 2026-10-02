#!/usr/bin/env node
/**
 * Check an unpacked MCP Bundle before it is published.
 *
 * `mcpb pack` validates the manifest, but not what ends up next to it, and not
 * whether the server starts. This script checks both on the unpacked bundle:
 *
 *   1. Contents: only the top-level entries .mcpbignore lets in, no dev
 *      dependency, no .env file or registry token anywhere.
 *   2. Boot: starts the server the way a client does — the manifest's command,
 *      args and env with ${__dirname} and ${user_config.*} filled in — from a
 *      directory outside the bundle, so a stray .env cannot help it, and checks
 *      that initialize and tools/list answer with the manifest's version and
 *      tools. The DAV server URL is unreachable on purpose: the server must
 *      start without it and connect on the first tool call.
 *
 * Usage: node scripts/verify-mcpb.js <unpacked-bundle-dir>
 */

import { spawn } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, resolve, sep } from 'path';

const ALLOWED_TOP_LEVEL = ['LICENSE', 'README.md', 'manifest.json', 'node_modules', 'package.json', 'src'];
const REQUIRED = ['manifest.json', 'package.json', 'LICENSE'];
const SECRET_FILE = /(^|\/)(\.env($|\.)|\.mcpregistry_)/;
const BOOT_TIMEOUT_MS = 15000;

// Values for the boot check, by user_config key. Settings with a default use it.
const DUMMY_USER_CONFIG = {
  server_url: 'https://example.invalid/dav/',
  username: 'verify',
  password: 'verify',
};

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exitCode = 1;
};

function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory()
      ? listFiles(path, base)
      : [relative(base, path).split(sep).join('/')];
  });
}

/**
 * Packages package-lock.json marks as dev-only, as node_modules paths.
 * Read from the repository's lockfile, since the bundle does not carry one.
 */
function devDependencyPaths() {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  return Object.entries(lock.packages)
    .filter(([path, meta]) => path && meta.dev)
    .map(([path]) => path);
}

function checkContents(bundleDir, manifest) {
  const files = listFiles(bundleDir);
  console.log(`${files.length} files in bundle`);

  const topLevel = [...new Set(files.map(f => f.split('/')[0]))].sort();
  const unexpected = topLevel.filter(entry => !ALLOWED_TOP_LEVEL.includes(entry));
  if (unexpected.length) fail(`unexpected top-level entries: ${unexpected.join(', ')}`);

  const missing = [...REQUIRED, manifest.server.entry_point].filter(f => !files.includes(f));
  if (missing.length) fail(`missing from bundle: ${missing.join(', ')}`);

  const secrets = files.filter(f => SECRET_FILE.test(f));
  if (secrets.length) fail(`secret-looking files in bundle: ${secrets.join(', ')}`);

  const devPackages = devDependencyPaths().filter(path => files.some(f => f.startsWith(`${path}/`)));
  if (devPackages.length) {
    fail(`dev dependencies in bundle (pack after npm ci --omit=dev): ${devPackages.slice(0, 10).join(', ')}` +
      (devPackages.length > 10 ? ` and ${devPackages.length - 10} more` : ''));
  }
}

/**
 * Fill in the placeholders a client substitutes in mcp_config.
 */
function substitute(value, bundleDir, manifest) {
  return value
    .replaceAll('${__dirname}', bundleDir)
    .replace(/\$\{user_config\.([a-z_]+)\}/g, (_, key) => {
      const setting = manifest.user_config[key];
      const filled = DUMMY_USER_CONFIG[key] ?? setting?.default;
      if (filled === undefined) throw new Error(`no value for user_config.${key}`);
      return String(filled);
    });
}

function boot(bundleDir, manifest) {
  const { command, args, env } = manifest.server.mcp_config;
  const childEnv = { PATH: process.env.PATH };
  for (const [name, value] of Object.entries(env)) {
    childEnv[name] = substitute(value, bundleDir, manifest);
  }
  const cwd = mkdtempSync(join(tmpdir(), 'mcpb-verify-'));

  // The manifest names `node`; run the node that runs this script.
  const executable = command === 'node' ? process.execPath : command;
  const child = spawn(executable, args.map(a => substitute(a, bundleDir, manifest)), {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return new Promise((resolvePromise, reject) => {
    const responses = new Map();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      rmSync(cwd, { recursive: true, force: true });
      if (error) reject(Object.assign(error, { stderr }));
      else resolvePromise(responses);
    };
    const timer = setTimeout(() => finish(new Error(`no tools/list answer within ${BOOT_TIMEOUT_MS} ms`)), BOOT_TIMEOUT_MS);

    child.stderr.on('data', d => { stderr += d; });
    child.on('error', finish);
    child.on('exit', (code) => finish(new Error(`server exited with code ${code} before answering`)));
    child.stdout.on('data', (data) => {
      stdout += data;
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines.filter(Boolean)) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error(`non-JSON line on stdout: ${line.slice(0, 200)}`));
          return;
        }
        responses.set(message.id, message);
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        }
        if (message.id === 2) finish();
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-mcpb', version: '1' } },
    }) + '\n');
  });
}

async function checkBoot(bundleDir, manifest) {
  let responses;
  try {
    responses = await boot(bundleDir, manifest);
  } catch (error) {
    fail(`server from bundle did not answer: ${error.message}`);
    if (error.stderr) console.error(error.stderr);
    return;
  }

  const serverInfo = responses.get(1).result?.serverInfo;
  console.log(`initialize: ${serverInfo?.name} ${serverInfo?.version}`);
  if (serverInfo?.version !== manifest.version) {
    fail(`server reports version ${serverInfo?.version}, manifest says ${manifest.version}`);
  }

  const served = (responses.get(2).result?.tools ?? []).map(t => t.name);
  const declared = manifest.tools.map(t => t.name);
  console.log(`tools/list: ${served.length} tools`);
  if (JSON.stringify(served) !== JSON.stringify(declared)) {
    fail(`tools/list differs from manifest tools: served [${served.join(', ')}], declared [${declared.join(', ')}]`);
  }
}

const bundleArg = process.argv[2];
if (!bundleArg) {
  console.error('Usage: node scripts/verify-mcpb.js <unpacked-bundle-dir>');
  process.exit(2);
}
const bundleDir = resolve(bundleArg);
const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));

checkContents(bundleDir, manifest);
await checkBoot(bundleDir, manifest);
if (!process.exitCode) console.log(`${manifest.name} ${manifest.version}: bundle verified`);
