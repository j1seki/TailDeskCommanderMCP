import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('.', import.meta.url));
const { version } = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
const cargo = await readFile(join(desktop, 'src-tauri', 'Cargo.toml'), 'utf8');
const tag = `desktop-v${version}`;
if (!/^\d+\.\d+\.\d+$/.test(version) || !cargo.includes(`version = "${version}"`)) {
  throw new Error('Use the same stable version in desktop/package.json and desktop/src-tauri/Cargo.toml.');
}

const prefix = `DesktopCommanderConnect-${version}`;
const platforms = {
  'windows-x64': ['windows-x86_64', '.exe'],
  'macos-arm64': ['darwin-aarch64', '.zip', '.app.tar.gz'],
  'macos-x64': ['darwin-x86_64', '.zip', '.app.tar.gz'],
  'linux-x64': ['linux-x86_64', '.AppImage'],
  'linux-arm64': ['linux-aarch64', '.AppImage'],
};

async function stage(platform, directory) {
  const [, extension, updateExtension] = platforms[platform];
  const target = join(desktop, 'src-tauri', 'target', 'release');
  const filename = `${prefix}-${platform}${extension}`;
  const destination = join(directory, filename);
  await mkdir(directory, { recursive: true });
  if (platform === 'windows-x64') {
    await copyFile(join(target, 'desktop-commander-connect.exe'), destination);
  } else if (platform.startsWith('linux')) {
    const arch = platform === 'linux-arm64' ? 'aarch64' : 'amd64';
    await copyFile(join(target, 'bundle', 'appimage', `Desktop Commander Connect_${version}_${arch}.AppImage`), destination);
    await chmod(destination, 0o755);
  } else {
    const bundle = join(target, 'bundle', 'macos');
    const name = 'Desktop Commander Connect.app';
    const app = join(bundle, name);
    execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--strict', app], { stdio: 'inherit' });
    execFileSync('ditto', ['-c', '-k', '--keepParent', app, destination], { stdio: 'inherit' });
    execFileSync('tar', ['-czf', join(directory, `${prefix}-${platform}${updateExtension}`), '-C', bundle, name],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  }
  console.log(filename);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function signRelease(directory, repo) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo ?? '')) throw new Error('A GitHub owner/repository is required.');
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error('Set TAURI_SIGNING_PRIVATE_KEY to the desktop updater signing key.');
  }
  const config = JSON.parse(await readFile(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const [, publicKey] = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8').trim().split('\n');
  const manifest = { version, pub_date: new Date().toISOString(), platforms: {} };
  const checksums = [];
  for (const [platform, [id, extension, updateExtension]] of Object.entries(platforms)) {
    const base = `${prefix}-${platform}`;
    const update = `${base}${updateExtension ?? extension}`;
    const artifact = join(directory, update);
    const signaturePath = `${artifact}.sig`;
    execFileSync(process.execPath, [join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
      'signer', 'sign', '--app-version', version, artifact], { stdio: 'ignore', env: process.env });
    const signature = (await readFile(signaturePath, 'utf8')).trim();
    const signatureText = Buffer.from(signature, 'base64').toString('utf8');
    const decodedPath = `${signaturePath}.minisign`;
    await writeFile(decodedPath, signatureText);
    try {
      execFileSync('minisign', ['-V', '-q', '-m', artifact, '-x', decodedPath, '-P', publicKey]);
    } finally {
      await unlink(decodedPath);
    }
    manifest.platforms[id] = { signature, url: `https://github.com/${repo}/releases/download/${tag}/${update}` };
    const download = `${base}${extension}`;
    for (const filename of new Set([download, update, `${update}.sig`])) {
      checksums.push(`${await sha256(join(directory, filename))}  ${filename}`);
    }
  }
  await writeFile(join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
}

const [action, argument, destination] = process.argv.slice(2);
if (action === 'version') {
  if (argument && argument !== tag) throw new Error(`The desktop release tag must be ${tag}.`);
  console.log(version);
} else if (action === 'stage' && Object.hasOwn(platforms, argument)) {
  await stage(argument, resolve(destination || 'desktop-release'));
} else if (action === 'sign') {
  await signRelease(resolve(destination || 'desktop-release'), argument);
} else {
  throw new Error('Use version [tag], stage <platform> [directory], or sign <owner/repo> [directory].');
}
