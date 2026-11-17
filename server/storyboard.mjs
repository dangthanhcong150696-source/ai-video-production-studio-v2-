import { createHash, randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./media.mjs";
import { failure } from "./limits.mjs";

export function defaultPrompts(scene) {
  const range = `source scene ${scene.id + 1}, ${scene.start.toFixed(2)}s–${(scene.start + scene.duration).toFixed(2)}s`;
  return {
    image: `Create a cinematic reference image based on the attached first and last frames of ${range}. Preserve subject identity, wardrobe, environment, composition and lighting from the references. Maintain consistent proportions and visual style. No new text or watermark. Describe your desired changes here.`,
    motion: `Animate the supplied reference image for ${scene.duration.toFixed(2)} seconds, using the first and last source frames of ${range} as continuity references. Preserve subject appearance and scene layout. Use subtle natural subject motion and a slow, stable camera move. Avoid morphing, flicker and invented details. Match the last-frame composition where supported.`,
  };
}
export async function ensureStoryboard(project, dir) {
  const deadline = Date.now() + 120000;
  const created = [];
  const pending = [];
  try {
    for (const scene of project.scenes) {
      const key = createHash("sha256")
        .update(`${scene.id}:${scene.start}:${scene.duration}`)
        .digest("hex")
        .slice(0, 16);
      const old = scene.storyboard || {};
      const refs = {};
      for (const edge of ['start','end']) {
        const file = `ref-${scene.id}-${key}-${edge}.jpg`;
        refs[edge] = file;
        if (await stat(join(dir, file)).catch(() => null)) continue;
        if (Date.now() >= deadline)
          throw failure("Trích ảnh tham chiếu quá 120 giây", 408);
        const temp = join(dir, `ref-tmp-${randomUUID()}.jpg`);
        created.push(temp);
        await run(
          "ffmpeg",
          [
            "-y",
            "-v",
            "error",
            "-threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-ss",
            String(scene.start),
            "-i",
            join(dir, "source.mp4"),
            ...(edge === "start"
              ? ["-frames:v", "1"]
              : [
                  "-t",
                  String(scene.duration),
                  "-an",
                  "-fps_mode",
                  "passthrough",
                  "-update",
                  "1",
                ]),
            "-filter_threads",
            "1",
            "-vf",
            "scale=640:640:force_original_aspect_ratio=decrease",
            "-q:v",
            "3",
            "-threads",
            "1",
            temp,
          ],
          Math.min(15000, deadline - Date.now()),
        );
        if ((await stat(temp)).size > 512 * 1024)
          throw failure("Ảnh tham chiếu vượt giới hạn 512 KiB");
        const { rename } = await import("node:fs/promises");
        await rename(temp, join(dir, file));
        created.push(join(dir, file));
      }
      const changed = old.referenceKey && old.referenceKey !== key;
      pending.push([
        scene,
        {
          ...old,
          referenceKey: key,
          refs,
          prompts: old.promptsEdited ? old.prompts : defaultPrompts(scene),
          promptsEdited: !!old.promptsEdited,
          needsReview: !!(
            old.needsReview ||
            (changed && (old.image || old.video))
          ),
        },
      ]);
    }
    for (const [scene, board] of pending) scene.storyboard = board;
  } catch (e) {
    await Promise.all(created.map((f) => unlink(f).catch(() => {})));
    throw e;
  }
}
export function editPrompts(scene, body) {
  for (const field of ["image", "motion"])
    if (typeof body[field] !== "string" || body[field].length > 4000)
      throw failure("Mỗi prompt phải là chuỗi, tối đa 4000 ký tự");
  scene.storyboard.prompts = { image: body.image, motion: body.motion };
  scene.storyboard.promptsEdited = true;
}
export function assetUsed(project, name) {
  return project.scenes.some(
    (s) =>
      s.replacement === name ||
      s.storyboard?.image?.file === name ||
      s.storyboard?.video?.file === name,
  );
}

export async function pruneReferences(project, dir) {
  const { readdir } = await import("node:fs/promises");
  const used = new Set(
    project.scenes.flatMap((s) => Object.values(s.storyboard?.refs || {})),
  );
  for (const name of await readdir(dir))
    if (name.startsWith("ref-") && !used.has(name))
      await unlink(join(dir, name)).catch(() => {});
}
