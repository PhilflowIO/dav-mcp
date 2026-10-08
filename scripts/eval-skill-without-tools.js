#!/usr/bin/env node
/**
 * Runs evals/skill-without-tools/ against the plugin's skill with no MCP
 * server — what claude.ai chat and Cowork load.
 *
 * `claude plugin eval` needs a plugin directory. This one is assembled in a
 * temporary directory from copies — a manifest without .mcp.json, the skills
 * from claude-plugin/skills/, and the cases as its evals/ — so nothing in
 * the repository is a symlink and the skill under test is always the current
 * one. The main suite in claude-plugin/evals/ cannot hold these cases: it
 * registers its dav-mcp mocks for any plugin named dav-mcp, so the run would
 * have the tools after all.
 *
 * Usage: node scripts/eval-skill-without-tools.js [claude plugin eval options]
 * e.g.   node scripts/eval-skill-without-tools.js --trust-plugin -j 2
 * The report goes to evals/skill-without-tools/results/ unless you pass
 * --output-dir.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = join(root, 'evals', 'skill-without-tools');
const manifest = JSON.parse(readFileSync(join(root, 'claude-plugin', '.claude-plugin', 'plugin.json'), 'utf8'));

const plugin = mkdtempSync(join(tmpdir(), 'dav-mcp-skill-only-'));
try {
  mkdirSync(join(plugin, '.claude-plugin'));
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    description: 'The dav-mcp skill without its MCP server, as claude.ai chat and Cowork load it. Eval fixture.',
    author: manifest.author,
  }, null, 2) + '\n');
  cpSync(join(root, 'claude-plugin', 'skills'), join(plugin, 'skills'), { recursive: true });
  cpSync(cases, join(plugin, 'evals'), { recursive: true, filter: (src) => !src.startsWith(join(cases, 'results')) });

  const args = process.argv.slice(2);
  if (!args.includes('--output-dir')) {
    args.push('--output-dir', join(cases, 'results', new Date().toISOString().replace(/[:.]/g, '-')));
  }
  const run = spawnSync('claude', ['plugin', 'eval', plugin, ...args], { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(plugin, { recursive: true, force: true });
}
