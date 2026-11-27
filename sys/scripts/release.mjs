import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gzipSync } from 'node:zlib';

const systemRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(systemRoot, '..');
const targets = ['windows-amd64', 'linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];
const args = process.argv.slice(2);
let sourceRef = 'HEAD';
let output;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--commit' && args[i + 1]) sourceRef = args[++i];
  else if (args[i] === '--output' && args[i + 1]) output = resolve(args[++i]);
  else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}

function run(command, parameters, options = {}) {
  const result = spawnSync(command, parameters, {
    cwd: systemRoot, env: process.env, encoding: 'utf8', ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.status}`);
  return (result.stdout || '').trim();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const packageInfo = JSON.parse(await readFile(join(systemRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(systemRoot, 'package-lock.json'), 'utf8'));
const version = packageInfo.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be major.minor.patch');
const configSource = await readFile(join(systemRoot, 'internal/coral/config.go'), 'utf8');
if (lock.version !== version || lock.packages[''].version !== version
  || !configSource.includes(`const Version = "${version}"`)) throw new Error('Runtime, package and lockfile versions differ');
output ??= join(repoRoot, 'output', `coral-${version}`, 'release');
const commit = run('git', ['rev-parse', '--verify', '--end-of-options', `${sourceRef}^{commit}`]);
if (commit !== run('git', ['rev-parse', 'HEAD'])) throw new Error('--commit must identify HEAD; builds use the current working tree');
const epoch = Number(run('git', ['show', '-s', '--format=%ct', commit]));
if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 0xffffffff) throw new Error('Unsupported source commit timestamp');
const trackedChanges = run('git', ['status', '--porcelain', '--untracked-files=no']);
const untrackedCode = run('git', ['ls-files', '--others', '--exclude-standard', '--', 'sys', 'README.md', 'LICENSE', 'run.cmd'], { cwd: repoRoot });
const dirty = Boolean(trackedChanges || untrackedCode);
const go = process.env.CORAL_GO || 'go';
const goVersion = run(go, ['version']);
const buildFlags = ['-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid='];
const source = { version, commit, source_date_epoch: epoch, working_tree: dirty ? 'dirty' : 'clean', go: goVersion };
if (dryRun) {
  console.log(JSON.stringify({ ...source, output, targets, build_flags: buildFlags }, null, 2));
  process.exit(0);
}
if (dirty) console.warn('Working tree has unpublished changes. These archives are previews; rebuild from the final clean release commit.');

const portableConfig = 'server:\n  host: "127.0.0.1"\n  port: 8300\ndata_dir: "."\nsearch:\n  results_per_page: 20\nvaults: {}\n';
function portableReadme(target) {
  const windows = target.startsWith('windows-');
  return `# Coral ${version}\n\n`+
    `这是 ${target} 的独立程序，运行无需 Node.js、npm 或 Go。\n\n`+
    (windows ? '双击 start.cmd，或在 PowerShell 中运行：\n\n\`\`\`powershell\n.\\coral.exe\n\`\`\`\n\n'
      : '在解压后的目录中运行：\n\n\`\`\`bash\n./coral\n\`\`\`\n\n')+
    '打开 http://127.0.0.1:8300。MCP 地址是 http://127.0.0.1:8300/mcp；stdio 使用 '+
    (windows ? '\`coral.exe --stdio\`' : '\`./coral --stdio\`')+'。按 Ctrl+C 停止服务。\n\n'+
    '首次运行会在程序旁创建 obsdian/default/，可在 Obsidian 中打开它。知识库位于 obsdian/，运行状态位于 .coral/；升级时保留这些目录和现有 config.yaml，只替换程序与说明文件。不要用空目录覆盖已有知识库。\n\n'+
    '默认无需配置。需要修改时，将 config.example.yaml 复制为 config.yaml；示例把数据保存在程序所在目录。也可用 --data-dir 指定已有数据根目录。建议安装 Git，以保存网页写操作的版本历史。\n\n'+
    '程序默认只监听本机，没有账号或鉴权。跨机器访问应通过带鉴权的反向代理接入。macOS 首次运行如被系统拦截，可在系统设置中确认打开此应用。\n\n'+
    '下载校验见同一发布页的 SHA256SUMS。BUILD.json 记录源码提交、工具链与构建参数。\n\n'+
    '项目与完整说明：https://github.com/lw-liuwang/coral\n';
}

// Archive headers use source time, fixed ownership and explicit modes.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const date = new Date(Math.max(epoch, 315532800) * 1000);
  const dosTime = date.getUTCHours() << 11 | date.getUTCMinutes() << 5 | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = (Math.min(date.getUTCFullYear(), 2107) - 1980) << 9 | (date.getUTCMonth() + 1) << 5 | date.getUTCDate();
  const local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const compressed = deflateRawSync(file.bytes, { level: 9 });
    const crc = crc32(file.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(((0o100000 | file.mode) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    local.push(header, name, compressed);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function tarGz(files) {
  const blocks = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    if (Buffer.byteLength(file.name) > 100) throw new Error('Archive filename exceeds ustar limit');
    header.write(file.name, 0, 100);
    const octal = (value, start, width) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', start, width);
    octal(file.mode, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(file.bytes.length, 124, 12);
    octal(epoch, 136, 12);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write('root', 265);
    header.write('root', 297);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }
  const bytes = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level: 9 });
  bytes[9] = 255;
  return bytes;
}

const temp = await mkdtemp(join(tmpdir(), 'coral-release-'));
if (dirname(temp) !== resolve(tmpdir()) || !basename(temp).startsWith('coral-release-')) throw new Error('Unexpected release temporary directory');
try {
  run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: 'inherit' });
  run(process.execPath, ['scripts/build-assets.mjs'], { stdio: 'inherit' });
  await mkdir(output, { recursive: true });
  const license = await readFile(join(repoRoot, 'LICENSE'));
  const assets = [];
  for (const target of targets) {
    const [os, arch] = target.split('-');
    const binaryName = os === 'windows' ? 'coral.exe' : 'coral';
    const binaryPath = join(temp, `${target}-${binaryName}`);
    console.log(`Building ${target}`);
    run(go, ['build', ...buildFlags, '-o', binaryPath, './cmd/coral'], {
      env: { ...process.env, GOOS: os, GOARCH: arch, GOAMD64: 'v1', GOARM64: 'v8.0', CGO_ENABLED: '0', GOTOOLCHAIN: 'local' },
      stdio: 'inherit',
    });
    const prefix = `coral-${version}-${target}`;
    const entries = [
      { name: binaryName, bytes: await readFile(binaryPath), mode: 0o755 },
      { name: 'LICENSE', bytes: license, mode: 0o644 },
      { name: 'README.md', bytes: Buffer.from(portableReadme(target)), mode: 0o644 },
      { name: 'config.example.yaml', bytes: Buffer.from(portableConfig), mode: 0o644 },
      { name: 'BUILD.json', bytes: Buffer.from(JSON.stringify({ ...source, target, build_flags: buildFlags }, null, 2) + '\n'), mode: 0o644 },
    ];
    if (os === 'windows') entries.push({ name: 'start.cmd', bytes: Buffer.from('@echo off\r\nsetlocal\r\npushd "%~dp0"\r\ncoral.exe %*\r\nset "coral_exit_code=%errorlevel%"\r\npopd\r\nif not "%coral_exit_code%"=="0" pause\r\nexit /b %coral_exit_code%\r\n'), mode: 0o644 });
    const files = entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map(file => ({ ...file, name: `${prefix}/${file.name}` }));
    const name = `${prefix}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
    const bytes = os === 'windows' ? zip(files) : tarGz(files);
    await writeFile(join(output, name), bytes);
    assets.push({ name, sha256: sha256(bytes), size: bytes.length });
  }
  const manifest = Buffer.from(JSON.stringify({ ...source, assets }, null, 2) + '\n');
  await writeFile(join(output, 'manifest.json'), manifest);
  await writeFile(join(output, 'SHA256SUMS'), [...assets, { name: 'manifest.json', sha256: sha256(manifest) }]
    .map(asset => `${asset.sha256}  ${asset.name}\n`).join(''));
  console.log(`Created ${assets.length} archives and SHA256SUMS in ${output}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
