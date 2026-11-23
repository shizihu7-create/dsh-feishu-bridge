/** Image sniffing and workspace file placement for phone uploads. */
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';

/** Detect the raster type of downloaded bytes; admission verifies the declared type again. */
export function sniffImageMediaType(bytes) {
  if (bytes === undefined || bytes === null || bytes.length < 12) return undefined;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

/** Keep a display name usable as a leaf filename on Windows and POSIX. */
export function safeFileName(name, fallback = 'feishu-file') {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim().slice(0, 120);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

function stampOf(clock) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    clock.getFullYear(),
    pad(clock.getMonth() + 1),
    pad(clock.getDate()),
  ].join('') + '-' + [pad(clock.getHours()), pad(clock.getMinutes()), pad(clock.getSeconds())].join('');
}

/**
 * Write one upload into `<cwd>/.feishu-uploads/`, keeping the original leaf name
 * behind a timestamp so the model can recognize it, and never overwriting.
 */
export async function saveUpload(cwd, name, bytes, clock = new Date()) {
  const dir = join(cwd, '.feishu-uploads');
  await mkdir(dir, { recursive: true });
  const leaf = safeFileName(name);
  const base = `${stampOf(clock)}-${leaf}`;
  let candidate = join(dir, base);
  for (let attempt = 1; attempt < 50; attempt += 1) {
    try {
      await access(candidate);
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const extension = dot > 0 ? base.slice(dot) : '';
      candidate = join(dir, `${stem}-${attempt}${extension}`);
    } catch {
      break;
    }
  }
  await writeFile(candidate, bytes);
  return { name: candidate.split(/[\\/]/).pop(), path: candidate, bytes: bytes.length };
}

/**
 * Read one file the phone asked to receive, refusing anything outside the
 * session working directory (resolved through symlinks) and anything over the
 * host's outbound budget.
 */
export async function readWorkspaceFile(cwd, input, maxBytes) {
  const requested = typeof input === 'string' ? input.trim() : '';
  if (requested === '') throw new Error('用法：/send <相对路径>');
  const base = await realpath(cwd);
  const target = isAbsolute(requested) ? requested : join(base, requested);
  let resolved;
  try {
    resolved = await realpath(target);
  } catch {
    throw new Error(`找不到文件：${requested}`);
  }
  const rel = relative(base, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('只能发送会话工作目录里的文件');
  }
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('这不是一个文件');
  if (info.size > maxBytes) {
    throw new Error(`文件 ${(info.size / (1024 * 1024)).toFixed(1)} MB，超过上限 ${Math.round(maxBytes / (1024 * 1024))} MB`);
  }
  if (info.size === 0) throw new Error('这是个空文件');
  return { name: basename(resolved), bytes: await readFile(resolved), size: info.size };
}
