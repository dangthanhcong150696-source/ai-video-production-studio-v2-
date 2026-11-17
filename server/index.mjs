import express from "express";
import multer from "multer";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { validateMedia, detect, render, editTimeline } from "./media.mjs";
import { providers, generateMedia, importMedia } from "./providers.mjs";
import {
  ensureStoryboard,
  editPrompts,
  assetUsed,
  pruneReferences,
} from "./storyboard.mjs";
import { limits, failure } from "./limits.mjs";
const app = express(),
  root = resolve(process.env.DATA_DIR || "data-v3");
await mkdir(join(root, "uploads"), { recursive: true });
const jobs = new Map();
let processing = false;
const dir = (id) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw failure("ID không hợp lệ");
  return join(root, id);
};
const load = async (id) =>
  JSON.parse(
    await readFile(join(dir(id), "project.json"), "utf8").catch((e) => {
      if (e.code === "ENOENT") throw failure("Không tìm thấy dự án", 404);
      throw e;
    }),
  );
const save = async (p) => {
  p.updatedAt = Date.now();
  const tmp = join(dir(p.id), "project.tmp");
  await writeFile(tmp, JSON.stringify(p, null, 2));
  await rename(tmp, join(dir(p.id), "project.json"));
};
async function bytes(path) {
  let sum = 0;
  for (const f of await readdir(path, { withFileTypes: true })) {
    const name = join(path, f.name);
    if (f.isDirectory()) sum += await bytes(name);
    else sum += (await stat(name)).size;
  }
  return sum;
}
async function cleanup() {
  for (const f of await readdir(root, { withFileTypes: true })) {
    const path = join(root, f.name);
    if (f.name === "uploads") {
      for (const item of await readdir(path))
        await rm(join(path, item), { force: true });
    } else if (f.isDirectory() && /^[a-f0-9-]{36}$/.test(f.name)) {
      const s = await stat(join(path, "project.json")).catch(() => stat(path));
      if (Date.now() - s.mtimeMs > limits.ttlMs) {
        await rm(path, { recursive: true, force: true });
        jobs.delete(f.name);
      }
    }
  }
}
await cleanup();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  if (process.env.STUDIO_PASSWORD && req.path !== "/api/health") {
    const expected = createHash("sha256")
      .update("studio:" + process.env.STUDIO_PASSWORD)
      .digest();
    const supplied = createHash("sha256")
      .update(
        Buffer.from(
          (req.headers.authorization || "").replace(/^Basic /, ""),
          "base64",
        ),
      )
      .digest();
    if (!timingSafeEqual(expected, supplied)) {
      res.set("WWW-Authenticate", 'Basic realm="Studio V3"');
      return res.status(401).send("Đăng nhập với user studio");
    }
  }
  next();
});
app.use(express.json({ limit: "16kb" }));
app.use("/api", (req, res, next) => {
  if (
    !["GET", "HEAD"].includes(req.method) &&
    req.get("sec-fetch-site") === "cross-site"
  )
    return next(failure("Không nhận yêu cầu ghi từ website khác", 403));
  next();
});
const upload = multer({
  dest: join(root, "uploads"),
  limits: {
    fileSize: limits.uploadBytes,
    files: 1,
    fields: 3,
    parts: 4,
    fieldSize: 1024,
  },
  fileFilter(req, file, cb) {
    if (
      ![".mp4", ".png", ".jpg", ".jpeg"].includes(
        extname(file.originalname).toLowerCase(),
      )
    )
      return cb(failure("Chỉ nhận MP4, PNG, JPEG", 415));
    cb(null, true);
  },
});
function transaction(
  handler,
  { field, uploadFile = false, freeSpace = false } = {},
) {
  return async (req, res, next) => {
    if (processing)
      return next(failure("Máy đang xử lý tác vụ khác; hãy thử lại sau", 429));
    processing = true;
    let response, error;
    try {
      await cleanup();
      if (
        !freeSpace &&
        (await bytes(root)) >
          limits.diskBytes - limits.uploadBytes - 128 * 1024 * 1024
      )
        throw failure("Không đủ quota lưu trữ; xóa dự án cũ trước", 507);
      if (uploadFile)
        await new Promise((ok, fail) =>
          upload.single(field || "video")(req, res, (e) =>
            e ? fail(e) : ok(),
          ),
        );
      response = await handler(req, res);
    } catch (e) {
      error = e;
    } finally {
      if (req.file) await unlink(req.file.path).catch(() => {});
      if (!response?.retain) processing = false;
    }
    if (error) return next(error);
    res.status(response?.status || 200).json(response?.body);
  };
}
const sceneOf = (p, id) => {
  const s = p.scenes.find((x) => x.id === Number(id));
  if (!s) throw failure("Không tìm thấy cảnh", 404);
  return s;
};
async function invalidate(p) {
  jobs.delete(p.id);
  await unlink(join(dir(p.id), "output.mp4")).catch(() => {});
  await save(p);
}
async function attach(p, s, file, meta) {
  const name = `media-${randomUUID()}${meta.extension || (meta.kind === "image" ? ".png" : ".mp4")}`;
  await rename(file, join(dir(p.id), name));
  const old = s.replacement;
  Object.assign(s, { replacement: name, ...meta });
  if (s.storyboard) s.storyboard.needsReview = true;
  await invalidate(p);
  if (old && !assetUsed(p, old))
    await unlink(join(dir(p.id), old)).catch(() => {});
}
app.get("/api/health", (req, res) => res.json({ ok: true, version: 3 }));
app.get("/api/config", (req, res) =>
  res.json({
    limits,
    providers,
    authentication: !!process.env.STUDIO_PASSWORD,
    processing,
  }),
);
app.post(
  "/api/projects",
  transaction(
    async (req, res) => {
      if (!req.file) throw failure("Hãy chọn video MP4");
      const info = await validateMedia(req.file.path, { source: true });
      const count = (await readdir(root)).filter((x) =>
        /^[a-f0-9-]{36}$/.test(x),
      ).length;
      if (count >= limits.maxProjects)
        throw failure("Tối đa 5 dự án; xóa dự án cũ trước", 429);
      const id = randomUUID();
      await mkdir(dir(id));
      try {
        await rename(req.file.path, join(dir(id), "source.mp4"));
        const scenes = await detect(join(dir(id), "source.mp4"), info.duration);
        const p = {
          id,
          name: req.file.originalname.slice(0, 200),
          ...info,
          scenes,
        };
        await ensureStoryboard(p, dir(id));
        await save(p);
        return { status: 201, body: p };
      } catch (e) {
        await rm(dir(id), { recursive: true, force: true });
        throw e;
      }
    },
    { uploadFile: true },
  ),
);
app.get("/api/projects/:id", async (req, res, next) => {
  try {
    res.json(await load(req.params.id));
  } catch (e) {
    next(e);
  }
});
app.delete(
  "/api/projects/:id",
  transaction(
    async (req, res) => {
      await load(req.params.id);
      await rm(dir(req.params.id), { recursive: true, force: true });
      jobs.delete(req.params.id);
      return { body: { deleted: true } };
    },
    { freeSpace: true },
  ),
);
app.patch(
  "/api/projects/:id/timeline",
  transaction(async (req, res) => {
    const p = await load(req.params.id);
    const scenes = editTimeline(p, req.body.scenes);
    if (scenes.reduce((n, s) => n + s.duration, 0) > limits.duration)
      throw failure("Timeline tối đa 120 giây");
    const removed = p.scenes.filter((s) => !scenes.some((x) => x.id === s.id));
    p.scenes = scenes;
    await ensureStoryboard(p, dir(p.id));
    await invalidate(p);
    await pruneReferences(p, dir(p.id));
    for (const s of removed)
      for (const name of [
        s.replacement,
        s.storyboard?.image?.file,
        s.storyboard?.video?.file,
      ].filter(Boolean))
        if (!assetUsed(p, name))
          await unlink(join(dir(p.id), name)).catch(() => {});
    return { body: p };
  }),
);
app.get("/api/projects/:id/source", async (req, res, next) => {
  try {
    await load(req.params.id);
    res.sendFile(join(dir(req.params.id), "source.mp4"), { dotfiles: "allow" });
  } catch (e) {
    next(e);
  }
});
app.post(
  "/api/projects/:id/scenes/:scene",
  transaction(
    async (req, res) => {
      if (!req.file) throw failure("Thiếu media thay thế");
      const p = await load(req.params.id),
        s = sceneOf(p, req.params.scene);
      const info = await validateMedia(req.file.path);
      const origin =
        req.body.origin === "google-flow" ? "google-flow" : "manual";
      await attach(p, s, req.file.path, {
        ...importMedia({ kind: info.kind, origin }),
        extension: info.extension,
      });
      return { body: p };
    },
    { uploadFile: true },
  ),
);
app.post(
  "/api/projects/:id/scenes/:scene/generate",
  transaction(async (req, res) => {
    const p = await load(req.params.id),
      s = sceneOf(p, req.params.scene);
    const file = join(
      root,
      "uploads",
      `${randomUUID()}.${req.body.kind === "image" ? "png" : "mp4"}`,
    );
    try {
      const meta = await generateMedia(req.body, file);
      await validateMedia(file);
      await attach(p, s, file, meta);
      return { body: p };
    } finally {
      await unlink(file).catch(() => {});
    }
  }),
);
app.get("/api/projects/:id/scenes/:scene/preview", async (req, res, next) => {
  try {
    const p = await load(req.params.id),
      s = sceneOf(p, req.params.scene);
    res.sendFile(join(dir(p.id), s.replacement || "source.mp4"), {
      dotfiles: "allow",
    });
  } catch (e) {
    next(e);
  }
});

app.post(
  "/api/projects/:id/storyboard",
  transaction(async (req) => {
    const p = await load(req.params.id);
    await ensureStoryboard(p, dir(p.id));
    await save(p);
    await pruneReferences(p, dir(p.id));
    return { body: p };
  }),
);
app.patch(
  "/api/projects/:id/storyboard/:scene/prompts",
  transaction(async (req) => {
    const p = await load(req.params.id),
      s = sceneOf(p, req.params.scene);
    if (!s.storyboard) throw failure("Khởi tạo Storyboard trước");
    editPrompts(s, req.body);
    await save(p);
    return { body: p };
  }),
);
app.get(
  "/api/projects/:id/storyboard/:scene/references/:edge",
  async (req, res, next) => {
    try {
      const p = await load(req.params.id),
        s = sceneOf(p, req.params.scene);
      if (!["start", "end"].includes(req.params.edge) || !s.storyboard?.refs)
        throw failure("Không tìm thấy ảnh tham chiếu", 404);
      res.sendFile(join(dir(p.id), s.storyboard.refs[req.params.edge]), {
        dotfiles: "allow",
      });
    } catch (e) {
      next(e);
    }
  },
);
app.get(
  "/api/projects/:id/storyboard/:scene/media/:kind",
  async (req, res, next) => {
    try {
      const p = await load(req.params.id),
        s = sceneOf(p, req.params.scene);
      if (
        !["image", "video"].includes(req.params.kind) ||
        !s.storyboard?.[req.params.kind]
      )
        throw failure("Không có media Storyboard", 404);
      res.sendFile(join(dir(p.id), s.storyboard[req.params.kind].file), {
        dotfiles: "allow",
      });
    } catch (e) {
      next(e);
    }
  },
);
app.post(
  "/api/projects/:id/storyboard/:scene/import/:kind",
  transaction(
    async (req) => {
      const p = await load(req.params.id),
        s = sceneOf(p, req.params.scene),
        kind = req.params.kind;
      if (!req.file) throw failure("Chưa chọn media");
      if (!["image", "video"].includes(kind))
        throw failure("Loại media không hợp lệ");
      const info = await validateMedia(req.file.path);
      if (info.kind !== kind)
        throw failure("Loại file không khớp ô nhập ảnh/video");
      if (!s.storyboard) throw failure("Khởi tạo Storyboard trước");
      const provider =
        kind === "image"
          ? "Nano Banana Pro"
          : req.body.provider === "Omni Plus"
            ? "Omni Plus"
            : "Omni Flash";
      const name = `story-${randomUUID()}${info.extension}`,
        old = s.storyboard[kind]?.file,
        previous = s.replacement;
      await rename(req.file.path, join(dir(p.id), name));
      s.storyboard[kind] = {
        file: name,
        provider,
        originalName: req.file.originalname.slice(0, 200),
        importedAt: Date.now(),
        source: "manual-google-flow",
        duration: Number.isFinite(info.duration) ? info.duration : null,
        width: info.width,
        height: info.height,
      };
      s.storyboard.needsReview =
        kind === "video"
          ? false
          : !!(s.storyboard.video && s.storyboard.needsReview);
      if (kind === "video" || !s.storyboard.video)
        Object.assign(s, {
          replacement: name,
          kind,
          origin: "google-flow",
          mode: "LIVE",
          networkCalls: 0,
        });
      await invalidate(p);
      for (const file of [old, previous].filter(Boolean))
        if (!assetUsed(p, file))
          await unlink(join(dir(p.id), file)).catch(() => {});
      return { body: p };
    },
    { uploadFile: true },
  ),
);
app.post(
  "/api/projects/:id/export",
  transaction(async (req, res) => {
    const p = await load(req.params.id);
    const job = { status: "running", progress: 0 };
    jobs.set(p.id, job);
    render(
      p,
      dir(p.id),
      (n) => (job.progress = n),
      async () => {
        if ((await bytes(root)) > limits.diskBytes - 128 * 1024 * 1024)
          throw failure("Vượt quota dữ liệu", 507);
      },
    )
      .then(() => (job.status = "done"))
      .catch(async (e) => {
        job.status = "failed";
        job.error = "Không thể xuất video: " + e.message;
        await unlink(join(dir(p.id), "output.mp4")).catch(() => {});
      })
      .finally(() => (processing = false));
    return { status: 202, body: job, retain: true };
  }),
);
app.get("/api/projects/:id/export", async (req, res, next) => {
  try {
    await load(req.params.id);
    res.json(jobs.get(req.params.id) || { status: "idle", progress: 0 });
  } catch (e) {
    next(e);
  }
});
app.get("/api/projects/:id/download", async (req, res, next) => {
  try {
    await load(req.params.id);
    if (jobs.get(req.params.id)?.status !== "done")
      throw failure("Chưa có bản xuất hoàn thành", 409);
    res.download(
      join(dir(req.params.id), "output.mp4"),
      "studio-v3-export.mp4",
      { dotfiles: "allow" },
    );
  } catch (e) {
    next(e);
  }
});
app.use(express.static(resolve("dist")));
app.use((err, req, res, next) => {
  const status = err.code === "LIMIT_FILE_SIZE" ? 413 : err.status || 400;
  const error =
    err.code === "LIMIT_FILE_SIZE"
      ? "File vượt giới hạn 50 MB"
      : status >= 500 && status !== 501 && status !== 507
        ? "Xử lý thất bại; hãy thử clip ngắn hơn"
        : err.message;
  console.error(err.message);
  res.status(status).json({ error });
});
const server = app.listen(Number(process.env.PORT || 3001), "0.0.0.0", () =>
  console.log("Studio V3 listening"),
);
server.requestTimeout = 120000;
server.headersTimeout = 30000;
server.maxConnections = 32;
