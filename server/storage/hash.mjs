// Workstream 1 — content identity for saved media.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { failure } from "../limits.mjs";

export function sha256File(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function mimeFor(filename) {
  switch (extname(filename).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

export function safeJoin(root, rel) {
  const target = resolve(root, rel);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep))
    throw failure("Đường dẫn không an toàn");
  return target;
}
