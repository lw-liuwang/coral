import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const child = spawn(resolve('dist', process.platform === 'win32' ? 'coral.exe' : 'coral'), process.argv.slice(2), { stdio: 'inherit' });
child.on('error', error => { console.error(`Build Coral first with npm run build. ${error.message}`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
