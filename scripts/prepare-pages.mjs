import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Append future releases; never replace or remove an installer at a published URL.
const downloads = [
  {
    url: 'https://github.com/mssteve/ai-karaoke-studio/releases/download/v0.4.0/Karaoke.Studio-Setup-0.4.0.exe',
    destination: 'downloads/v0.4.0/Karaoke.Studio-Setup-0.4.0.exe',
    size: 495769406,
    sha256: 'cc3420d6a72bd9bcb655f364149d935fa31940054617143766d66f0f395d405c'
  }
];
// Leave space below the 1 GB Pages limit for archive metadata.
const maxSiteBytes = 950_000_000;
const docs = fileURLToPath(new URL('../docs/', import.meta.url));

export async function verifyInstaller(file, expected) {
  const details = await lstat(file);
  if (!details.isFile() || details.nlink !== 1 || details.size !== expected.size) {
    throw new Error(`Installer size/type/link mismatch: ${file}`);
  }
  const hash = createHash('sha256');
  let header;
  for await (const chunk of createReadStream(file)) {
    header ??= chunk.subarray(0, 2);
    hash.update(chunk);
  }
  if (header?.toString('ascii') !== 'MZ') {
    throw new Error(`Installer is not an MZ executable: ${file}`);
  }
  if (hash.digest('hex') !== expected.sha256) {
    throw new Error(`Installer SHA256 mismatch: ${file}`);
  }
}

async function copyDocs(source, destination) {
  for (const name of await readdir(source)) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const details = await lstat(from);
    if (details.isDirectory()) {
      await mkdir(to);
      await copyDocs(from, to);
    } else if (details.isFile() && details.nlink === 1) {
      await copyFile(from, to, constants.COPYFILE_EXCL);
    } else {
      throw new Error(`Docs must contain only regular files/directories, without links: ${from}`);
    }
  }
}

async function siteSize(directory) {
  let bytes = 0;
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    const details = await lstat(file);
    if (details.isDirectory()) {
      bytes += await siteSize(file);
    } else if (details.isFile() && details.nlink === 1) {
      bytes += details.size;
    } else {
      throw new Error(`Pages staging contains a link or unsupported file: ${file}`);
    }
  }
  return bytes;
}

async function downloadInstaller(entry, destination) {
  const partial = `${destination}.download`;
  try {
    const response = await fetch(entry.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    if (response.status !== 200 || !response.url.startsWith('https://') || !response.body) {
      throw new Error(`Installer download failed: HTTP ${response.status}`);
    }
    const type = response.headers.get('content-type') ?? '';
    const length = response.headers.get('content-length');
    if (/text\/|html|json/i.test(type) || (length !== null && Number(length) !== entry.size)) {
      throw new Error('Installer response has unexpected content type or size');
    }
    let bytes = 0;
    await pipeline(
      response.body,
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > entry.size) throw new Error('Installer response exceeds pinned size');
          yield chunk;
        }
      },
      createWriteStream(partial, { flags: 'wx' })
    );
    await verifyInstaller(partial, entry);
    await rename(partial, destination);
    console.log(`Verified ${entry.destination}: ${entry.size} bytes, SHA256 ${entry.sha256}`);
  } finally {
    await rm(partial, { force: true });
  }
}

async function preparePages(output) {
  // Require a new directory, never delete an existing tree or stage inside docs.
  const resolved = path.resolve(output);
  const stage = path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
  const source = await realpath(docs);
  const relative = path.relative(source, stage);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Pages output must be outside docs');
  }
  await mkdir(stage);
  await copyDocs(source, stage);
  const expectedSize = await siteSize(stage) + downloads.reduce((sum, entry) => sum + entry.size, 0);
  if (expectedSize > maxSiteBytes) throw new Error('Pages site exceeds the 950,000,000-byte safety limit');
  // Reserve this namespace: docs cannot shadow or redirect immutable downloads.
  await mkdir(path.join(stage, 'downloads'));
  for (const entry of downloads) {
    const destination = path.join(stage, ...entry.destination.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await downloadInstaller(entry, destination);
  }
  const bytes = await siteSize(stage);
  if (bytes !== expectedSize || bytes > maxSiteBytes) throw new Error('Pages staging size mismatch');
  console.log(`Pages staging ready: ${stage} (${bytes} bytes, no links)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    console.error('Usage: node scripts/prepare-pages.mjs <new-output-directory>');
    process.exitCode = 1;
  } else {
    await preparePages(args[0]).catch(error => {
      console.error(`Pages preparation failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
