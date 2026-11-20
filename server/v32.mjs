// Workstream 2 — save, list, restore, and portable bundle endpoints.
import { randomUUID } from "node:crypto";
import multer from "multer";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { normalizeCharacter, applyCharacterToProject } from "./character.mjs";
import { failure } from "./limits.mjs";
import { buildManifest, verifyAndStage } from "./manifest.mjs";
import { validateMedia } from "./media.mjs";
import { mimeFor, safeJoin, sha256File } from "./storage/hash.mjs";
import { extractBundle, writeZip } from "./storage/zip.mjs";

const bundleBytes = 256 * 1024 * 1024;

async function zipFrom(manifest, files) {
  const entries = [
    {
      name: "manifest.json",
      data: Buffer.from(JSON.stringify(manifest, null, 2)),
    },
  ];
  for (const file of files)
    entries.push({ name: file.path, data: await readFile(file.absPath) });
  return entries;
}

export function registerV32(app, { root, dir, load, save, transaction, jobs, storage }) {
  const bundleUpload = multer({
    dest: join(root, "uploads"),
    limits: { fileSize: bundleBytes, files: 1, fields: 2, parts: 3 },
    fileFilter(req, file, cb) {
      if (extname(file.originalname).toLowerCase() !== ".zip")
        return cb(failure("Bundle phải là file .zip", 415));
      cb(null, true);
    },
  });
  const characterUpload = multer({
    dest: join(root, "uploads"),
    limits: {
      fileSize: 8 * 1024 * 1024,
      files: 4,
      fields: 12,
      parts: 16,
      fieldSize: 8000,
    },
    fileFilter(req, file, cb) {
      if (![".png", ".jpg", ".jpeg"].includes(extname(file.originalname).toLowerCase()))
        return cb(failure("Ảnh tham chiếu phải là PNG hoặc JPEG", 415));
      cb(null, true);
    },
  });

  function backendOf(req) {
    return storage.backend(req.body?.backend || req.query.backend || storage.requested);
  }

  async function restoreLoaded(loaded) {
    const id = loaded.manifest?.project?.id;
    const staging = join(root, `.restore-${id || randomUUID()}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      const project = await verifyAndStage(
        loaded.manifest,
        loaded.directory,
        staging,
        root,
      );
      project.persisted = true;
      project.restoredAt = new Date().toISOString();
      const tmp = join(staging, "project.tmp");
      await writeFile(tmp, JSON.stringify(project, null, 2));
      await rename(tmp, join(staging, "project.json"));
      const target = dir(project.id);
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      jobs.delete(project.id);
      return project;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    } finally {
      if (loaded.temporary)
        await rm(loaded.directory, { recursive: true, force: true });
    }
  }

  async function sendZip(res, next, filename, entries) {
    const zipPath = join(tmpdir(), `${randomUUID()}.zip`);
    try {
      await writeZip(zipPath, entries);
      res.download(zipPath, filename, () => unlink(zipPath).catch(() => {}));
    } catch (error) {
      await unlink(zipPath).catch(() => {});
      next(error);
    }
  }

  app.get("/api/projects", async (req, res, next) => {
    try {
      const projects = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        try {
          const project = JSON.parse(
            await readFile(join(root, entry.name, "project.json"), "utf8"),
          );
          projects.push({
            id: project.id,
            name: project.name,
            updatedAt: project.updatedAt || null,
            duration: project.duration,
            width: project.width,
            height: project.height,
            sceneCount: project.scenes?.length || 0,
            persisted: project.persisted === true,
            savedAt: project.savedAt || null,
            rightsFlagged: !!project.characterLock?.rightsFlagged,
            characterName: project.characterLock?.name || null,
          });
        } catch {
          /* A directory without a readable project is not listed. */
        }
      }
      projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      res.json({ projects });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/storage", async (req, res, next) => {
    try {
      res.json(await storage.status());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/saved", async (req, res, next) => {
    try {
      const backend = backendOf(req);
      res.json({ backend: backend.id, projects: await backend.list() });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/projects/:id/save",
    transaction(async (req) => {
      const project = await load(req.params.id);
      const backend = backendOf(req);
      const built = await buildManifest(project, dir(project.id), root);
      const stored = await backend.save(built.manifest, built.blobs);
      project.persisted = true;
      project.savedAt = built.manifest.savedAt;
      project.storageBackend = stored.backend;
      await save(project);
      return {
        body: {
          saved: true,
          id: project.id,
          backend: stored.backend,
          manifestVersion: built.manifest.manifestVersion,
          savedAt: built.manifest.savedAt,
          fileCount: built.manifest.files.length,
          rightsFlagged: !!project.characterLock?.rightsFlagged,
          configured: true,
        },
      };
    }),
  );

  app.post(
    "/api/saved/:id/restore",
    transaction(async (req) => {
      const loaded = await backendOf(req).load(req.params.id);
      if (loaded.manifest?.project?.id !== req.params.id)
        throw failure("Manifest không thuộc id đã yêu cầu", 409);
      return { body: await restoreLoaded(loaded) };
    }),
  );

  app.get("/api/projects/:id/bundle", async (req, res, next) => {
    try {
      const project = await load(req.params.id);
      const built = await buildManifest(project, dir(project.id), root);
      await sendZip(
        res,
        next,
        `${project.id}.studio-v3.2.zip`,
        await zipFrom(
          built.manifest,
          built.blobs.map((blob) => ({ path: blob.path, absPath: blob.absPath })),
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/saved/:id/bundle", async (req, res, next) => {
    try {
      const loaded = await backendOf(req).load(req.params.id);
      try {
        if (loaded.manifest?.project?.id !== req.params.id)
          throw failure("Manifest không thuộc id đã yêu cầu", 409);
        await sendZip(
          res,
          next,
          `${req.params.id}.studio-v3.2.zip`,
          await zipFrom(
            loaded.manifest,
            loaded.manifest.files.map((file) => ({
              path: file.path,
              absPath: safeJoin(loaded.directory, file.path),
            })),
          ),
        );
      } finally {
        if (loaded.temporary)
          await rm(loaded.directory, { recursive: true, force: true });
      }
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/bundles",
    transaction(
      async (req) => {
        if (!req.file) throw failure("Thiếu file bundle .zip");
        const dest = join(tmpdir(), `studio-bundle-${randomUUID()}`);
        await mkdir(dest, { recursive: true });
        try {
          const manifest = await extractBundle(req.file.path, dest);
          return {
            status: 201,
            body: await restoreLoaded({
              manifest,
              directory: dest,
              temporary: true,
            }),
          };
        } catch (error) {
          await rm(dest, { recursive: true, force: true });
          throw error;
        }
      },
      { uploadFile: true, uploader: bundleUpload, field: "bundle" },
    ),
  );

  async function createCharacter(req, files) {
    let input = req.body || {};
    if (typeof input.character === "string") {
      try {
        input = { ...input, ...JSON.parse(input.character) };
      } catch {
        throw failure("JSON nhân vật không hợp lệ");
      }
    }
    const normalized = normalizeCharacter(input);
    const id = randomUUID();
    const folder = join(root, "characters", id);
    await mkdir(folder, { recursive: true });
    const referenceImages = [];
    try {
      for (const [index, file] of files.entries()) {
        const info = await validateMedia(file.path);
        if (info.kind !== "image")
          throw failure("Ảnh tham chiếu phải là PNG hoặc JPEG");
        const filename = `ref-${index}${info.extension}`;
        const relativePath = `characters/${id}/${filename}`;
        await copyFile(file.path, join(folder, filename));
        const abs = join(folder, filename);
        referenceImages.push({
          filename,
          relativePath,
          sha256: await sha256File(abs),
          size: (await stat(abs)).size,
          mime: mimeFor(filename),
        });
      }
      const record = {
        id,
        ...normalized,
        referenceImages,
        createdAt: new Date().toISOString(),
      };
      await writeFile(join(folder, "character.json"), JSON.stringify(record, null, 2));
      return { status: 201, body: record };
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
  }

  app.post("/api/characters", (req, res, next) => {
    const json = (req.headers["content-type"] || "").includes("application/json");
    const handler = async (request) =>
      createCharacter(request, json ? [] : request.files || []);
    return (
      json
        ? transaction(handler)
        : transaction(handler, {
            uploadFile: true,
            uploader: characterUpload,
            field: "reference",
            array: 4,
          })
    )(req, res, next);
  });

  app.get("/api/characters", async (req, res, next) => {
    try {
      const folder = join(root, "characters");
      let names = [];
      try {
        names = await readdir(folder);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const characters = [];
      for (const name of names) {
        try {
          characters.push(
            JSON.parse(await readFile(join(folder, name, "character.json"), "utf8")),
          );
        } catch {
          /* skip unreadable records */
        }
      }
      res.json({ characters });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/characters/:id", async (req, res, next) => {
    try {
      if (!/^[a-f0-9-]{36}$/.test(req.params.id)) throw failure("ID không hợp lệ");
      res.json(
        JSON.parse(
          await readFile(join(root, "characters", req.params.id, "character.json"), "utf8"),
        ),
      );
    } catch (error) {
      if (error.code === "ENOENT") return next(failure("Không tìm thấy nhân vật", 404));
      next(error);
    }
  });

  app.get("/api/characters/:id/references/:index", async (req, res, next) => {
    try {
      if (!/^[a-f0-9-]{36}$/.test(req.params.id)) throw failure("ID không hợp lệ");
      const record = JSON.parse(
        await readFile(join(root, "characters", req.params.id, "character.json"), "utf8"),
      );
      const image = record.referenceImages?.[Number(req.params.index)];
      if (!image) throw failure("Không có ảnh tham chiếu", 404);
      res.sendFile(safeJoin(root, image.relativePath), { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/projects/:id/character",
    transaction(async (req) => {
      const project = await load(req.params.id);
      const characterId = req.body?.characterId;
      if (!/^[a-f0-9-]{36}$/.test(characterId || ""))
        throw failure("Thiếu characterId");
      let record;
      try {
        record = JSON.parse(
          await readFile(join(root, "characters", characterId, "character.json"), "utf8"),
        );
      } catch (error) {
        if (error.code === "ENOENT") throw failure("Không tìm thấy nhân vật", 404);
        throw error;
      }
      applyCharacterToProject(project, record);
      await save(project);
      return { body: project };
    }),
  );

  app.delete(
    "/api/projects/:id/character",
    transaction(async (req) => {
      const project = await load(req.params.id);
      delete project.characterLock;
      for (const scene of project.scenes)
        if (scene.storyboard) scene.storyboard.lockedPromptPrefix = "";
      await save(project);
      return { body: project };
    }),
  );
}
