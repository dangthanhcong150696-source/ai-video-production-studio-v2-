// Workstream 1 — local directory backend (SAVE_DIR).
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { failure } from "../limits.mjs";
import { safeJoin } from "./hash.mjs";

async function materialize(dest, manifest, blobs) {
  await mkdir(dest, { recursive: true });
  const body = JSON.stringify(manifest, null, 2);
  await writeFile(join(dest, "manifest.json"), body);
  for (const blob of blobs) {
    const target = safeJoin(dest, blob.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(blob.absPath, target);
  }
}

export function createLocalBackend(directory) {
  const root = resolve(directory);
  return {
    id: "local",
    directory: root,
    async init() {
      await mkdir(root, { recursive: true });
    },
    status() {
      return {
        backend: "local",
        configured: true,
        directory: root,
        reason: "",
      };
    },
    async save(manifest, blobs) {
      const id = manifest.project?.id;
      if (!/^[a-f0-9-]{36}$/.test(id || "")) throw failure("ID không hợp lệ");
      const finalDir = join(root, id);
      const tmp = join(root, `.tmp-${id}-${randomUUID()}`);
      try {
        await materialize(tmp, manifest, blobs);
        await rm(finalDir, { recursive: true, force: true });
        await rename(tmp, finalDir);
      } catch (error) {
        await rm(tmp, { recursive: true, force: true });
        throw error;
      }
      return { id, backend: "local", directory: finalDir };
    },
    async list() {
      const projects = [];
      let names = [];
      try {
        names = await readdir(root);
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      for (const name of names) {
        if (!/^[a-f0-9-]{36}$/.test(name)) continue;
        try {
          const manifest = JSON.parse(
            await readFile(join(root, name, "manifest.json"), "utf8"),
          );
          const project = manifest.project || {};
          projects.push({
            id: project.id || name,
            name: project.name || name,
            savedAt: manifest.savedAt || null,
            manifestVersion: manifest.manifestVersion,
            sceneCount: project.scenes?.length || 0,
            duration: project.duration ?? null,
            rightsFlagged: !!project.characterLock?.rightsFlagged,
            backend: "local",
          });
        } catch (error) {
          projects.push({
            id: name,
            backend: "local",
            error: error.message,
          });
        }
      }
      projects.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
      return projects;
    },
    async load(id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw failure("ID không hợp lệ");
      const directory = join(root, id);
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT")
          throw failure("Không tìm thấy dự án đã lưu", 404);
        throw error;
      }
      return { manifest, directory, temporary: false };
    },
  };
}
