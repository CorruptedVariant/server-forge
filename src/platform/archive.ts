// Zip files on Linux, in plain Node: the Windows code uses .NET's zip tools, and SteamOS or a minimal server can't be
// counted on to have unzip or zip. Handles large files (zip64), keeps "executable" flags, and refuses entries that point
// outside the destination. Files are streamed, so a 50 GB world backup doesn't need 50 GB of memory.
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, closeSync, readSync, readdirSync, chmodSync, fstatSync, writeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createDeflateRaw, createInflateRaw, crc32 } from 'node:zlib';
import path from 'node:path';

const MAX32 = 0xffffffff;
const num64 = (buf: Buffer, at: number) => Number(buf.readBigUInt64LE(at));

interface CentralEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
  mode: number; // Unix mode, or 0 when the zip was made on Windows
  flags: number;
}

function readAt(fd: number, pos: number, len: number) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

function readCentral(fd: number): CentralEntry[] {
  const size = fstatSync(fd).size;
  const tailLen = Math.min(size, 65_557);
  const tail = readAt(fd, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('That is not a zip file.');
  let count = tail.readUInt16LE(eocd + 10);
  let dirSize = tail.readUInt32LE(eocd + 12);
  let dirStart = tail.readUInt32LE(eocd + 16);
  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === 0x07064b50) {
    const end64 = readAt(fd, num64(tail, locator + 8), 56);
    if (end64.readUInt32LE(0) === 0x06064b50) {
      count = num64(end64, 32);
      dirSize = num64(end64, 40);
      dirStart = num64(end64, 48);
    }
  }
  const dir = readAt(fd, dirStart, dirSize);
  const out: CentralEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= dir.length; i++) {
    if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip file is damaged.');
    const madeByUnix = dir.readUInt8(p + 5) === 3;
    const nameLen = dir.readUInt16LE(p + 28);
    const extraLen = dir.readUInt16LE(p + 30);
    const commentLen = dir.readUInt16LE(p + 32);
    let compressed = dir.readUInt32LE(p + 20);
    let size_ = dir.readUInt32LE(p + 24);
    let offset = dir.readUInt32LE(p + 42);
    const extraStart = p + 46 + nameLen;
    for (let e = extraStart; e + 4 <= extraStart + extraLen; ) {
      const id = dir.readUInt16LE(e);
      const len = dir.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size_ === MAX32) (size_ = num64(dir, q)), (q += 8);
        if (compressed === MAX32) (compressed = num64(dir, q)), (q += 8);
        if (offset === MAX32) offset = num64(dir, q);
      }
      e += 4 + len;
    }
    out.push({
      name: dir.toString('utf-8', p + 46, extraStart).replace(/\\/g, '/'),
      method: dir.readUInt16LE(p + 10),
      compressed,
      size: size_,
      offset,
      mode: madeByUnix ? dir.readUInt32LE(p + 38) >>> 16 : 0,
      flags: dir.readUInt16LE(p + 8),
    });
    p = extraStart + extraLen + commentLen;
  }
  return out;
}

/** Unpacks a zip into `dest` (created if needed), replacing files already there. */
export async function unzipFile(zip: string, dest: string): Promise<void> {
  const root = path.resolve(dest);
  mkdirSync(root, { recursive: true });
  const fd = openSync(zip, 'r');
  try {
    for (const e of readCentral(fd)) {
      const target = path.resolve(root, e.name);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`The zip has an entry outside its folder (${e.name}).`);
      if (e.flags & 1) throw new Error('The zip is password-protected.');
      if (e.name.endsWith('/')) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      if ((e.mode & 0o170000) === 0o120000) continue; // symbolic links: could point anywhere, and no game server zip needs them
      if (e.method !== 0 && e.method !== 8) throw new Error(`The zip uses a compression method Server Forge can't read (${e.name}).`);
      mkdirSync(path.dirname(target), { recursive: true });
      const local = readAt(fd, e.offset, 30);
      if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error('The zip file is damaged.');
      const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const out = createWriteStream(target);
      if (e.compressed === 0) await new Promise<void>((resolve, reject) => out.on('error', reject).end(() => resolve()));
      else {
        const input = createReadStream('', { fd, autoClose: false, start, end: start + e.compressed - 1 });
        if (e.method === 8) await pipeline(input, createInflateRaw(), out);
        else await pipeline(input, out);
      }
      if (e.mode & 0o111) chmodSync(target, 0o755);
    }
  } finally {
    closeSync(fd);
  }
}

function listFiles(dir: string, base: string, out: { rel: string; full: string; size: number; dir: boolean; mode: number; mtime: Date }[]) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    const rel = base ? `${base}/${d.name}` : d.name;
    // Symbolic links and sockets aren't backed up: following one could pull in files from outside the folder.
    if (d.isDirectory()) {
      const st = lstatSync(full);
      out.push({ rel: `${rel}/`, full, size: 0, dir: true, mode: st.mode, mtime: st.mtime });
      listFiles(full, rel, out);
    } else if (d.isFile()) {
      const st = lstatSync(full);
      out.push({ rel, full, size: st.size, dir: false, mode: st.mode, mtime: st.mtime });
    }
  }
}

function dosDateTime(d: Date) {
  const year = Math.max(d.getFullYear(), 1980);
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** Zips everything inside `source` (not the folder itself) into a new file `zip`. */
export async function zipDirectory(source: string, zip: string): Promise<void> {
  const files: Parameters<typeof listFiles>[2] = [];
  listFiles(source, '', files);
  const fd = openSync(zip, 'w');
  const central: Buffer[] = [];
  let pos = 0;
  const write = (buf: Buffer, at = pos) => {
    writeSync(fd, buf, 0, buf.length, at);
    if (at === pos) pos += buf.length;
  };
  try {
    for (const f of files) {
      const name = Buffer.from(f.rel, 'utf-8');
      const { time, date } = dosDateTime(f.mtime);
      const start = pos;
      // Files near or over 4 GB reserve room for their real sizes in the header; everything else stays a plain entry.
      const big = f.size >= 0xfff00000;
      const local = Buffer.alloc(30 + name.length + (big ? 20 : 0));
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(big ? 45 : 20, 4);
      local.writeUInt16LE(0x0800, 6); // file names are UTF-8
      local.writeUInt16LE(f.dir ? 0 : 8, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(big ? 20 : 0, 28);
      name.copy(local, 30);
      write(local);
      let crc = 0;
      let compressed = 0;
      let size = 0;
      if (!f.dir) {
        const writer = new Transform({
          transform(chunk: Buffer, _enc, done) {
            write(chunk);
            compressed += chunk.length;
            done();
          },
        });
        const counter = new Transform({
          transform(chunk: Buffer, _enc, done) {
            crc = crc32(chunk, crc);
            size += chunk.length;
            done(null, chunk);
          },
        });
        await pipeline(createReadStream(f.full), counter, createDeflateRaw(), writer, async (s: Readable) => {
          for await (const _ of s) void _;
        });
      }
      // The sizes are only known now: fill them into the header.
      const fix = Buffer.alloc(12);
      fix.writeUInt32LE(crc >>> 0, 0);
      fix.writeUInt32LE(big ? MAX32 : compressed, 4);
      fix.writeUInt32LE(big ? MAX32 : size, 8);
      writeSync(fd, fix, 0, 12, start + 14);
      if (big) {
        const extra = Buffer.alloc(20);
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(16, 2);
        extra.writeBigUInt64LE(BigInt(size), 4);
        extra.writeBigUInt64LE(BigInt(compressed), 12);
        writeSync(fd, extra, 0, 20, start + 30 + name.length);
      }
      const wide = big || start >= MAX32 || compressed >= MAX32 || size >= MAX32;
      const c = Buffer.alloc(46 + name.length + (wide ? 28 : 0));
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE((3 << 8) | 45, 4); // made on Unix, so the mode below counts
      c.writeUInt16LE(wide ? 45 : 20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(f.dir ? 0 : 8, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc >>> 0, 16);
      c.writeUInt32LE(wide ? MAX32 : compressed, 20);
      c.writeUInt32LE(wide ? MAX32 : size, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt16LE(wide ? 28 : 0, 30);
      c.writeUInt32LE(((f.mode & 0xffff) << 16) >>> 0, 38);
      c.writeUInt32LE(wide ? MAX32 : start, 42);
      name.copy(c, 46);
      if (wide) {
        const at = 46 + name.length;
        c.writeUInt16LE(1, at);
        c.writeUInt16LE(24, at + 2);
        c.writeBigUInt64LE(BigInt(size), at + 4);
        c.writeBigUInt64LE(BigInt(compressed), at + 12);
        c.writeBigUInt64LE(BigInt(start), at + 20);
      }
      central.push(c);
    }
    const dirStart = pos;
    for (const c of central) write(c);
    const dirSize = pos - dirStart;
    const wide = dirStart >= MAX32 || dirSize >= MAX32 || central.length >= 0xffff;
    if (wide) {
      const end64At = pos;
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(0x06064b50, 0);
      end64.writeBigUInt64LE(44n, 4);
      end64.writeUInt16LE((3 << 8) | 45, 12);
      end64.writeUInt16LE(45, 14);
      end64.writeBigUInt64LE(BigInt(central.length), 24);
      end64.writeBigUInt64LE(BigInt(central.length), 32);
      end64.writeBigUInt64LE(BigInt(dirSize), 40);
      end64.writeBigUInt64LE(BigInt(dirStart), 48);
      write(end64);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(end64At), 8);
      locator.writeUInt32LE(1, 16);
      write(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(central.length, 0xffff), 8);
    end.writeUInt16LE(Math.min(central.length, 0xffff), 10);
    end.writeUInt32LE(Math.min(dirSize, MAX32), 12);
    end.writeUInt32LE(Math.min(dirStart, MAX32), 16);
    write(end);
  } finally {
    closeSync(fd);
  }
  if (!existsSync(zip)) throw new Error('The zip file was not written.');
}
