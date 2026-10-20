import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configModule = new URL('../src/config.ts', import.meta.url).href;
const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;

function readConfig(cwd: string, overrides: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CORAL_')));
  return JSON.parse(execFileSync(process.execPath, [
    '--import', loader, '--input-type=module', '-e',
    `import { loadConfig } from ${JSON.stringify(configModule)}; console.log(JSON.stringify(loadConfig()));`,
  ], { cwd, env: { ...env, ...overrides }, encoding: 'utf8' }));
}

test('default data directory is beside sys even when started from another directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coral-config-'));
  try {
    const systemRoot = join(directory, 'sys');
    mkdirSync(systemRoot);
    const filename = join(systemRoot, 'config.yaml');
    writeFileSync(filename, '{}');
    const config = readConfig(tmpdir(), { CORAL_CONFIG: filename });
    assert.equal(config.data_dir, directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('custom configuration resolves Vault paths relative to the configuration file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coral-config-'));
  try {
    const settings = join(directory, 'settings');
    mkdirSync(settings);
    const filename = join(settings, 'config.yaml');
    writeFileSync(filename, 'data_dir: ../notes\nvaults:\n  project:\n    path: ../project\n');
    const config = readConfig(tmpdir(), { CORAL_CONFIG: filename });
    assert.equal(config.data_dir, join(directory, 'notes'));
    assert.equal(config.vaults.project.path, join(directory, 'project'));
    const overridden = readConfig(tmpdir(), { CORAL_CONFIG: filename, CORAL_DATA_DIR: join(directory, 'override') });
    assert.equal(overridden.data_dir, join(directory, 'override'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
