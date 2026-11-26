import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'build') {
  mkdirSync('dist', { recursive: true });
  args.push('-trimpath', '-o', join('dist', process.platform === 'win32' ? 'coral.exe' : 'coral'), './cmd/coral');
}
const result = spawnSync(process.env.CORAL_GO || 'go', args, { stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' } });
if (result.error) console.error(`Cannot run Go. Install Go 1.26+ or set CORAL_GO. ${result.error.message}`);
process.exit(result.status ?? 1);
