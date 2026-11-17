import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, probe, detect } from "../server/media.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  "MP4 upload → split ≤8s → replace → normalize → export with original audio",
  { timeout: 180000 },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "studio-test-"));
    const source = join(work, "source.mp4"),
      replacement = join(work, "replacement.mp4");
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:r=30:d=17",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=17",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      source,
    ]);
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=180x320:r=24:d=1",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-pix_fmt",
      "yuv420p",
      replacement,
    ]);
    const port = 43127;
    const server = spawn(process.execPath, ["server/index.mjs"], {
      env: { ...process.env, PORT: String(port), DATA_DIR: join(work, "data") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    server.stderr.on("data", (b) => (logs += b));
    const base = `http://127.0.0.1:${port}/api`;
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/health")).ok) {
            ready = true;
            break;
          }
        } catch {}
        await sleep(100);
      }
      assert.ok(ready, logs);
      async function upload(path, file) {
        const body = new FormData();
        body.append(
          "video",
          new Blob([await readFile(file)], { type: "video/mp4" }),
          "fixture.mp4",
        );
        const r = await fetch(base + path, { method: "POST", body });
        const json = await r.json();
        assert.ok(r.ok, JSON.stringify(json));
        return json;
      }
      let p = await upload("/projects", source);
      assert.equal(p.scenes.length, 3);
      assert.deepEqual(
        p.scenes.map((s) => s.duration),
        [8, 8, 1],
      );
      assert.ok(p.audio);
      p = await upload(`/projects/${p.id}/scenes/1`, replacement);
      assert.ok(p.scenes[1].replacement);
      const start = await fetch(base + `/projects/${p.id}/export`, {
        method: "POST",
      });
      assert.equal(start.status, 202);
      let job;
      for (let i = 0; i < 500; i++) {
        job = await (await fetch(base + `/projects/${p.id}/export`)).json();
        if (job.status !== "running") break;
        await sleep(100);
      }
      assert.equal(job.status, "done", JSON.stringify(job));
      const response = await fetch(base + `/projects/${p.id}/download`);
      assert.equal(response.status, 200);
      await mkdir("evidence", { recursive: true });
      const output = join(work, "output.mp4");
      await writeFile(output, Buffer.from(await response.arrayBuffer()));
      const info = await probe(output);
      assert.ok(info.audio);
      assert.equal(info.width, 320);
      assert.equal(info.height, 180);
      assert.ok(Math.abs(info.duration - 17) < 0.1);
      await run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
      const { out } = await run("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        output,
      ]);
      const streams = JSON.parse(out).streams;
      assert.equal(
        streams.find((s) => s.codec_type === "video").codec_name,
        "h264",
      );
      assert.equal(
        streams.find((s) => s.codec_type === "audio").codec_name,
        "aac",
      );
      // Decode a pixel at the center of the replacement scene: it must be red, not blue.
      const pixelFile = join(work, "pixel.rgb");
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-ss",
        "9",
        "-i",
        output,
        "-frames:v",
        "1",
        "-vf",
        "crop=2:2:160:90,scale=1:1,format=rgb24",
        "-f",
        "rawvideo",
        pixelFile,
      ]);
      const pixel = await readFile(pixelFile);
      assert.ok(
        pixel[0] > 200 && pixel[1] < 40 && pixel[2] < 40,
        `Expected red replacement, got ${[...pixel]}`,
      );
      // Compare decoded audio to the source to ensure the original tone survived replacement.
      const audio = await run("ffmpeg", [
        "-v",
        "info",
        "-ss",
        "9",
        "-t",
        "1",
        "-i",
        output,
        "-vn",
        "-af",
        "astats",
        "-f",
        "null",
        "-",
      ]);
      assert.match(audio.err, /RMS level dB: -[12]\d\./);
      const invalid = new FormData();
      invalid.append("video", new Blob(["bad"]), "bad.mp4");
      assert.equal(
        (await fetch(base + "/projects", { method: "POST", body: invalid }))
          .status,
        400,
      );
      const silent = await upload("/projects", replacement);
      assert.equal(silent.audio, false);
      await fetch(base + `/projects/${silent.id}/export`, { method: "POST" });
      let silentJob;
      for (let i = 0; i < 200; i++) {
        silentJob = await (
          await fetch(base + `/projects/${silent.id}/export`)
        ).json();
        if (silentJob.status !== "running") break;
        await sleep(100);
      }
      assert.equal(silentJob.status, "done", JSON.stringify(silentJob));
      const silentFile = join(work, "silent-output.mp4");
      await writeFile(
        silentFile,
        Buffer.from(
          await (
            await fetch(base + `/projects/${silent.id}/download`)
          ).arrayBuffer(),
        ),
      );
      assert.equal((await probe(silentFile)).audio, false);
      await writeFile(
        join(work, "validation.json"),
        JSON.stringify(
          {
            testedAt: new Date().toISOString(),
            source: {
              duration: 17,
              width: 320,
              height: 180,
              audio: "440 Hz sine",
            },
            scenes: p.scenes.map((s) => ({
              start: s.start,
              duration: s.duration,
              replaced: !!s.replacement,
            })),
            replacement: { duration: 1, width: 180, height: 320, audio: false },
            output: info,
            codecs: streams.map((s) => ({
              type: s.codec_type,
              codec: s.codec_name,
            })),
            checks: [
              "3 scenes: 8+8+1 seconds",
              "portrait silent replacement looped to 8 seconds",
              "original audio present during replacement",
              "full FFmpeg decode succeeded",
              "invalid upload rejected",
              "replacement pixel verified red",
              "silent source exported successfully",
            ],
          },
          null,
          2,
        ),
      );
    } finally {
      server.kill("SIGTERM");
    }
  },
);
test("scene detection recognizes hard cuts", async () => {
  const work = await mkdtemp(join(tmpdir(), "studio-cut-"));
  const file = join(work, "cut.mp4");
  await run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:s=160x90:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=white:s=160x90:r=30:d=2",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    file,
  ]);
  const scenes = await detect(file, 4);
  assert.equal(scenes.length, 2);
  assert.ok(Math.abs(scenes[0].duration - 2) < 0.1);
});
