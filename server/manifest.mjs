// Workstream 2 — versioned saved-project manifest.
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { failure } from "./limits.mjs";
import { probe } from "./media.mjs";
import { effectivePrompt } from "./character.mjs";
import { mimeFor, safeJoin, sha256File } from "./storage/hash.mjs";

export const MANIFEST_VERSION = 1;
export const APP_VERSION = "3.2";

function mediaEntry(spec, facts) {
  for (const key of ["path", "filename", "sha256", "size", "mime", "role"]) {
    if (spec[key] === undefined || spec[key] === null || spec[key] === "")
      throw failure(`Media thiếu ${key}`);
  }
  if (!/^[a-f0-9]{64}$/.test(spec.sha256))
    throw failure(`sha256 không hợp lệ cho ${spec.path}`);
  if (!Number.isInteger(spec.size) || spec.size < 0)
    throw failure(`Kích thước không hợp lệ cho ${spec.path}`);
  return { ...spec, ...facts };
}

export function assertManifest(manifest) {
  if (!manifest || manifest.manifestVersion !== MANIFEST_VERSION)
    throw failure("manifestVersion không được hỗ trợ");
  const project = manifest.project;
  if (!project || !/^[a-f0-9-]{36}$/.test(project.id || ""))
    throw failure("Manifest thiếu id dự án");
  if (!Array.isArray(project.scenes) || !project.scenes.length)
    throw failure("Manifest thiếu cảnh");
  if (!Array.isArray(project.timeline) || project.timeline.length !== project.scenes.length)
    throw failure("Timeline không khớp danh sách cảnh");
  project.scenes.forEach((scene, index) => {
    if (!Number.isInteger(scene.id) || scene.id < 0)
      throw failure("ID cảnh phải là số nguyên từ 0");
    const mark = project.timeline[index];
    if (
      !mark ||
      mark.sceneId !== scene.id ||
      mark.start !== scene.start ||
      mark.duration !== scene.duration
    )
      throw failure(`Timeline lệch tại cảnh ${scene.id}`);
    if (!Array.isArray(scene.media) || !scene.media.length)
      throw failure(`Cảnh ${scene.id} thiếu media`);
  });
  if (!project.source?.sha256) throw failure("Manifest thiếu thông tin nguồn");
  const character = project.characterLock;
  if (character) {
    if (!["owned", "licensed", "internal-only", "unknown"].includes(character.rightsStatus))
      throw failure("Character lock thiếu rightsStatus hợp lệ");
    const flagged =
      character.rightsStatus === "unknown" || character.rightsStatus === "internal-only";
    if (character.rightsFlagged !== flagged)
      throw failure("Cờ quyền nhân vật không khớp rightsStatus");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length)
    throw failure("Manifest thiếu danh sách file");
  const required = [
    project.source,
    ...project.scenes.flatMap((scene) => scene.media),
    ...(character?.referenceImages || []),
    ...(project.lastExport ? [project.lastExport] : []),
  ];
  for (const entry of required) {
    mediaEntry(entry);
    const stored = manifest.files.find((file) => file.path === entry.path);
    if (!stored || stored.sha256 !== entry.sha256 || stored.size !== entry.size)
      throw failure(`manifest.files không khớp ${entry.path}`);
  }
  return manifest;
}

async function describe(absPath, spec) {
  const info = await stat(absPath);
  const sha256 = await sha256File(absPath);
  return mediaEntry({
    ...spec,
    sha256,
    size: info.size,
    mime: spec.mime || mimeFor(spec.filename),
  });
}

export async function buildManifest(project, projectDir, dataRoot) {
  const files = [];
  const blobs = [];
  const byPath = new Map();
  async function track(absPath, spec) {
    let entry = byPath.get(spec.path);
    if (!entry) {
      entry = await describe(absPath, spec);
      byPath.set(spec.path, entry);
      files.push(entry);
      blobs.push({ path: spec.path, absPath, mime: entry.mime });
    } else if (entry.sha256 !== (await sha256File(absPath))) {
      throw failure(`Trùng đường dẫn với nội dung khác: ${spec.path}`);
    }
    return { ...entry, role: spec.role };
  }
  const sourceAbs = join(projectDir, "source.mp4");
  let sourceFacts = {};
  try {
    sourceFacts = await probe(sourceAbs);
  } catch {
    throw failure("Không đọc được video nguồn để lưu");
  }
  const source = await track(sourceAbs, {
    path: "media/source.mp4",
    filename: "source.mp4",
    role: "source",
    place: "project",
    duration: sourceFacts.duration,
    width: sourceFacts.width,
    height: sourceFacts.height,
    fps: sourceFacts.fps,
    audio: sourceFacts.audio,
    frames: sourceFacts.frames,
  });
  const snapshot = structuredClone(project);
  snapshot.source = source;
  snapshot.timeline = snapshot.scenes.map((scene, index) => ({
    index,
    sceneId: scene.id,
    start: scene.start,
    duration: scene.duration,
  }));
  const prefix = snapshot.characterLock?.promptPrefix || "";
  for (const scene of snapshot.scenes) {
    const media = [];
    if (scene.replacement) {
      media.push(
        await track(join(projectDir, scene.replacement), {
          path: `media/${scene.replacement}`,
          filename: scene.replacement,
          role: "replacement",
          place: "project",
        }),
      );
    } else {
      media.push({ ...source, role: "source-span" });
    }
    const refs = scene.storyboard?.refs || {};
    for (const edge of ["start", "end"]) {
      if (!refs[edge]) continue;
      media.push(
        await track(join(projectDir, refs[edge]), {
          path: `media/${refs[edge]}`,
          filename: refs[edge],
          role: `reference-${edge}`,
          place: "project",
        }),
      );
    }
    for (const kind of ["image", "video"]) {
      const filename = scene.storyboard?.[kind]?.file;
      if (!filename) continue;
      media.push(
        await track(join(projectDir, filename), {
          path: `media/${filename}`,
          filename,
          role: `storyboard-${kind}`,
          place: "project",
        }),
      );
    }
    scene.media = media;
    if (prefix) {
      scene.effectivePrompts = {
        image: effectivePrompt(prefix, scene.storyboard?.prompts?.image || ""),
        motion: effectivePrompt(prefix, scene.storyboard?.prompts?.motion || ""),
      };
    }
  }
  if (snapshot.characterLock) {
    const images = [];
    for (const image of snapshot.characterLock.referenceImages || []) {
      const relative =
        image.relativePath ||
        join("characters", snapshot.characterLock.id, image.filename);
      const absPath = safeJoin(dataRoot, relative);
      images.push(
        await track(absPath, {
          path: `media/character/${snapshot.characterLock.id}/${image.filename}`,
          filename: image.filename,
          role: "character-reference",
          place: "character",
          characterId: snapshot.characterLock.id,
          relativePath: relative.split("\\").join("/"),
        }),
      );
    }
    snapshot.characterLock = {
      ...snapshot.characterLock,
      referenceImages: images,
    };
  }
  let lastExport = null;
  const exportAbs = join(projectDir, "output.mp4");
  if (await stat(exportAbs).then(() => true).catch(() => false)) {
    const facts = await probe(exportAbs);
    lastExport = await track(exportAbs, {
      path: "media/export.mp4",
      filename: "output.mp4",
      role: "export",
      place: "project",
      exportedAt: new Date().toISOString(),
      duration: facts.duration,
      width: facts.width,
      height: facts.height,
      fps: facts.fps,
      frames: facts.frames,
      audio: facts.audio,
    });
  }
  snapshot.lastExport = lastExport;
  snapshot.persisted = true;
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    studio: "ai-video-production-studio",
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
    project: snapshot,
    files,
  };
  assertManifest(manifest);
  return { manifest, blobs };
}

export async function verifyAndStage(manifest, directory, staging, dataRoot) {
  assertManifest(manifest);
  const problems = [];
  const seen = new Set();
  for (const file of manifest.files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    let abs;
    try {
      abs = safeJoin(directory, file.path);
    } catch {
      problems.push({ path: file.path, reason: "missing" });
      continue;
    }
    const info = await stat(abs).catch(() => null);
    if (!info) {
      problems.push({ path: file.path, reason: "missing" });
      continue;
    }
    const actual = await sha256File(abs);
    if (actual !== file.sha256)
      problems.push({
        path: file.path,
        reason: "mismatch",
        expected: file.sha256,
        actual,
      });
    else if (info.size !== file.size)
      problems.push({
        path: file.path,
        reason: "size",
        expected: file.size,
        actual: info.size,
      });
  }
  if (problems.length) {
    const detail = problems
      .map((problem) =>
        problem.reason === "mismatch"
          ? `${problem.path}: sha256 mismatch expected ${problem.expected} actual ${problem.actual}`
          : `${problem.path}: ${problem.reason}`,
      )
      .join("; ");
    const error = failure(
      `Khôi phục thất bại: ${problems.length} media thiếu hoặc không khớp sha256. ${detail}`,
      409,
    );
    error.mismatches = problems;
    throw error;
  }
  const { dirname } = await import("node:path");
  for (const file of manifest.files) {
    const from = safeJoin(directory, file.path);
    const target =
      file.place === "character"
        ? safeJoin(
            dataRoot,
            file.relativePath || join("characters", file.characterId, file.filename),
          )
        : safeJoin(staging, file.filename);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(from, target);
  }
  return structuredClone(manifest.project);
}
