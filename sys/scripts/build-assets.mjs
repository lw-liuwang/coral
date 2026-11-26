import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const output = resolve('internal/assets/web');
if (dirname(output) !== resolve('internal/assets')) throw new Error('Unexpected web asset directory');
const notice = await readFile(resolve(output, 'README.txt'));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'README.txt'), notice);
await build({ entryPoints: ['src/client.ts', 'src/mermaid-frame.ts', 'src/html-frame.ts', 'src/html-runtime.ts'], bundle: true, minify: true, outdir: output });
await cp('static', output, { recursive: true });
await cp(dirname(require.resolve('katex/dist/katex.min.css')), resolve(output, 'katex'), { recursive: true });
