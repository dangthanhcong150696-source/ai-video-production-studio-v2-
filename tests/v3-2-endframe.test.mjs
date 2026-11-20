// Regression: an 8.04s clip that covers an 8.00s scene must not loop back to frame 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { run } from "../server/media.mjs";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "8.04s replacement rendered into an 8s scene keeps the end frame",
  { timeout: 180000 },
  async () => {
    const clip = await findClip("Woman_smiling_in_car_interior_59b4e7c1");
    const work = await mkdtemp(join(tmpdir(), "studio-endframe-"));
    const data = join(work, "data");
    const port = 43145;
    const server = spawn(process.execPath, ["server/index.mjs"], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: data,
        SAVE_DIR: join(work, "saves"),
        STORAGE_BACKEND: "local",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    server.stderr.on("data", (chunk) => (logs += chunk));
    const base = `http://127.0.0.1:${port}/api`;
    try {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/health")).ok) break;
        } catch {
          /* retry */
        }
        if (i === 99) throw new Error(logs);
        await sleep(100);
      }
      const project = await postFile(base + "/projects", clip);
      assert.equal(project.scenes.length, 1);
      assert.ok(project.scenes[0].duration >= 7.9 && project.scenes[0].duration <= 8);
      const replaced = await postFile(
        `${base}/projects/${project.id}/scenes/0`,
        clip,
      );
      assert.equal(replaced.scenes[0].kind, "video");
      let job = await postJson(`${base}/projects/${project.id}/export`, {});
      for (let i = 0; job.status !== "done" && i < 120; i++) {
        if (job.status === "failed") throw new Error(job.error);
        await sleep(500);
        job = await (await fetch(`${base}/projects/${project.id}/export`)).json();
      }
      assert.equal(job.status, "done");
      const output = join(work, "export.mp4");
      const response = await fetch(`${base}/projects/${project.id}/download`);
      assert.equal(response.status, 200);
      await writeFile(output, Buffer.from(await response.arrayBuffer()));
      const frames = join(work, "frames");
      await mkdir(frames);
      await grab(output, join(frames, "last.png"), { frame: 239 });
      await grab(output, join(frames, "first.png"), { frame: 0 });
      await grab(clip, join(frames, "src-first.png"), { time: 0.1 });
      await grab(clip, join(frames, "src-last.png"), { time: 7.9 });
      const versusFirst = await ssim(join(frames, "last.png"), join(frames, "first.png"));
      const versusSourceFirst = await ssim(
        join(frames, "last.png"),
        join(frames, "src-first.png"),
        true,
      );
      const versusSourceEnd = await ssim(
        join(frames, "last.png"),
        join(frames, "src-last.png"),
        true,
      );
      assert.ok(
        versusFirst < 0.85,
        `last frame snapped toward the first frame (SSIM ${versusFirst})`,
      );
      assert.ok(
        versusSourceEnd > versusSourceFirst + 0.05,
        `last frame SSIM ${versusSourceEnd} is not closer to the clip end than the start ${versusSourceFirst}`,
      );
    } finally {
      server.kill("SIGTERM");
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  },
);

async function findClip(prefix) {
  const roots = [
    process.env.V32_FIXTURE_DIR,
    "/home/ubuntu/.cursor/projects/workspace/uploads",
    join(process.cwd(), "uploads"),
  ].filter(Boolean);
  for (const root of roots) {
    let names = [];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    const match = names.find((name) => name.startsWith(prefix) && name.endsWith(".mp4"));
    if (match) return join(root, match);
  }
  throw new Error(`Missing clip ${prefix}`);
}

async function postFile(url, file) {
  const body = new FormData();
  body.append("video", new Blob([await readFile(file)]), basename(file));
  const response = await fetch(url, { method: "POST", body });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function grab(file, dest, { time, frame } = {}) {
  const select = Number.isInteger(frame)
    ? ["-vf", `select=eq(n\\,${frame})`, "-frames:v", "1"]
    : ["-ss", String(time), "-frames:v", "1"];
  await run("ffmpeg", ["-y", "-v", "error", "-i", file, ...select, dest]);
}

async function ssim(left, right, scaleSecond = false) {
  const filter = scaleSecond
    ? "[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,format=yuv420p[b];[0:v]format=yuv420p[a];[a][b]ssim"
    : "ssim";
  const result = await run("ffmpeg", [
    "-i",
    left,
    "-i",
    right,
    "-lavfi",
    filter,
    "-f",
    "null",
    "-",
  ]);
  const value = Number((result.err.match(/All:([0-9.]+)/) || [])[1]);
  if (!Number.isFinite(value)) throw new Error(result.err.slice(-400));
  return value;
}
