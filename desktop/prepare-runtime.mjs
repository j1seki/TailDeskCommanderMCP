import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const source = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.DC_DESKTOP_RUNTIME_DIR
  ? resolve(process.env.DC_DESKTOP_RUNTIME_DIR)
  : fileURLToPath(new URL('./generated', import.meta.url));
const platform = process.env.DC_DESKTOP_RUNTIME_PLATFORM || process.platform;
const arch = process.env.DC_DESKTOP_RUNTIME_ARCH || process.arch;
const windows = platform === 'win32';
const native = platform === process.platform && arch === process.arch;
const nodeName = windows ? 'node.exe' : 'node';
if (!native && !['darwin', 'win32'].includes(platform)) {
  throw new Error('Cross-staging is supported for Windows and macOS. Prepare Linux packages on their target architecture.');
}
const staging = await mkdtemp(join(tmpdir(), 'dc-connect-runtime-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
}

async function fetchFile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function copyNode() {
  const target = join(staging, nodeName);
  const version = `v${process.versions.node}`;
  if (native) {
    await copyFile(process.execPath, target);
  } else {
    const release = `https://nodejs.org/dist/${version}`;
    const darwinDirectory = `node-${version}-darwin-${arch}`;
    const relative = windows ? `win-${arch}/node.exe` : `${darwinDirectory}.tar.gz`;
    const [binary, sums] = await Promise.all([fetchFile(`${release}/${relative}`), fetchFile(`${release}/SHASUMS256.txt`)]);
    const expected = sums.toString().split('\n').find(line => line.endsWith(`  ${relative}`))?.split(' ')[0];
    if (!expected || createHash('sha256').update(binary).digest('hex') !== expected) throw new Error('Node archive checksum mismatch');
    if (windows) {
      await writeFile(target, binary);
    } else {
      const archive = join(staging, relative);
      await writeFile(archive, binary);
      run('tar', ['-xzf', archive, '--strip-components=2', `${darwinDirectory}/bin/node`], staging);
      await rm(archive);
    }
  }
  if (!windows) await chmod(target, 0o755);
  const license = join(staging, 'LICENSE.node');
  try {
    await copyFile(join(dirname(process.execPath), windows && native ? '.' : '..', 'LICENSE'), license);
  } catch {
    await writeFile(license, await fetchFile(`https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`));
  }
}

async function copyRipgrep() {
  const packageDir = join(staging, 'node_modules', '@vscode', 'ripgrep');
  if (native) {
    run(process.execPath, ['lib/postinstall.js'], packageDir);
  } else {
    const rgVersion = '15.1.0';
    const triple = `${arch === 'x64' ? 'x86_64' : 'aarch64'}-${windows ? 'pc-windows-msvc' : 'apple-darwin'}`;
    const directory = `ripgrep-${rgVersion}-${triple}`;
    const filename = `${directory}.${windows ? 'zip' : 'tar.gz'}`;
    const archive = join(staging, filename);
    const url = `https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}/${filename}`;
    const [binary, sha] = await Promise.all([fetchFile(url), fetchFile(`${url}.sha256`)]);
    const expected = sha.toString().match(/\b[a-f0-9]{64}\b/i)?.[0].toLowerCase();
    if (createHash('sha256').update(binary).digest('hex') !== expected) {
      throw new Error('ripgrep archive checksum mismatch');
    }
    await writeFile(archive, binary);
    const bin = join(packageDir, 'bin');
    await mkdir(bin);
    if (windows) run('unzip', ['-j', archive, '*/rg.exe', '-d', bin], staging);
    else run('tar', ['-xzf', archive, '--strip-components=1', `${directory}/rg`], bin);
    await rm(archive);
  }
  await readFile(join(packageDir, 'bin', windows ? 'rg.exe' : 'rg'));
}

try {
  const rootPackage = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await mkdir(output, { recursive: true });
  await cp(join(source, 'dist'), join(staging, 'dist'), { recursive: true });
  for (const name of ['chatgpt-mcp.mjs', 'chatgpt-oauth.mjs']) {
    const dir = join(staging, 'scripts');
    await mkdir(dir, { recursive: true });
    await copyFile(join(source, 'scripts', name), join(dir, name));
  }
  await writeFile(join(staging, 'package.json'), JSON.stringify(rootPackage));
  await copyFile(join(source, 'LICENSE'), join(staging, 'LICENSE.desktop-commander'));
  await copyFile(join(source, 'package-lock.json'), join(staging, 'package-lock.json'));
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run the packager with npm run prepare-runtime.');
  run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund', `--os=${platform}`, `--cpu=${arch}`], staging);
  await copyNode();
  await copyRipgrep();
  await rm(join(staging, 'package-lock.json'));
  // The Windows tar extractor cannot create POSIX npm links on a normal user account.
  for (const entry of await readdir(staging, { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error(`Portable runtime contains an unsupported file type: ${join(entry.parentPath, entry.name)}`);
    }
  }
  const archive = join(output, 'runtime.tar.gz');
  const temporary = `${archive}.new`;
  const tar = spawn(windows && native ? 'tar.exe' : 'tar', ['-c', '-f', '-', '-C', staging, '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const packed = new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', code => code === 0 ? resolve() : reject(new Error(`tar failed with ${code}`)));
  });
  await Promise.all([packed, pipeline(tar.stdout, createGzip({ level: 6 }), createWriteStream(temporary))]);
  await rename(temporary, archive);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  await writeFile(join(output, 'runtime.id'), hash.digest('hex'));
  console.log(`Embedded ${platform}-${arch} runtime in ${archive}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
