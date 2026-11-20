// Workstream 1 — portable project bundles (manifest.json + media).
import { inflateRawSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { failure } from "../limits.mjs";

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++)
    c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function safeZipName(name) {
  const norm = String(name).replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !norm ||
    norm.includes("\0") ||
    norm.split("/").some((part) => part === ".." || part === ".")
  )
    throw failure("Đường dẫn ZIP không an toàn");
  return norm;
}

export async function writeZip(outPath, entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = safeZipName(entry.name);
    const nameBuf = Buffer.from(name);
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  await writeFile(outPath, Buffer.concat([...parts, ...central, eocd]));
}

export function readZip(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50)
    throw failure("File không phải ZIP bundle");
  let eocd = -1;
  const min = Math.max(0, buffer.length - (22 + 65535));
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw failure("ZIP thiếu thư mục trung tâm");
  const count = buffer.readUInt16LE(eocd + 8);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff)
    throw failure("ZIP64 chưa được hỗ trợ");
  const entries = [];
  let cursor = cdOffset;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw failure("Thư mục ZIP bị hỏng");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = safeZipName(
      buffer.toString("utf8", cursor + 46, cursor + 46 + nameLen),
    );
    cursor += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize)
      throw failure(`ZIP cắt cụt tại ${name}`);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw failure(`Phương thức nén ZIP ${method} không được hỗ trợ`);
    entries.push({ name, data });
  }
  return entries;
}

export async function extractBundle(zipPath, destDir) {
  const entries = readZip(await readFile(zipPath));
  const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
  if (!manifestEntry) throw failure("Bundle thiếu manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  } catch {
    throw failure("manifest.json không phải JSON hợp lệ");
  }
  const base = resolve(destDir);
  await mkdir(base, { recursive: true });
  await writeFile(resolve(base, "manifest.json"), manifestEntry.data);
  for (const entry of entries) {
    if (entry.name === "manifest.json") continue;
    if (entry.name.startsWith("__MACOSX/") || entry.name.endsWith("/.DS_Store"))
      continue;
    if (!entry.name.startsWith("media/"))
      throw failure(`Bundle chứa đường dẫn không được phép: ${entry.name}`);
    const target = resolve(base, entry.name);
    if (target !== base && !target.startsWith(base + sep))
      throw failure("ZIP slip");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data);
  }
  return manifest;
}
