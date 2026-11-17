import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { run, probe } from "../server/media.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  "V3.1 storyboard references, edited prompts, bound imports and MP4 export",
  { timeout: 120000 },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "studio-v31-"));
    const source = join(work, "sample.mp4"),
      image = join(work, "nano.png"),
      clip = join(work, "omni.mp4");
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=9",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=9:sample_rate=48000",
      "-c:v",
      "libx264",
      "-threads",
      "1",
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
      "color=green:s=320x180",
      "-frames:v",
      "1",
      "-threads",
      "1",
      image,
    ]);
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=yellow:s=180x320:r=48:d=1",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      clip,
    ]);
    const port = 43135,
      server = spawn(process.execPath, ["server/index.mjs"], {
        env: {
          ...process.env,
          PORT: String(port),
          DATA_DIR: join(work, "data"),
        },
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
      const request = async (path, body, method = "POST") => {
        const r = await fetch(base + path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const p = await r.json();
        assert.ok(r.ok, JSON.stringify(p));
        return p;
      };
      async function upload(path, file, provider) {
        const body = new FormData();
        body.append(
          "video",
          new Blob([await readFile(file)]),
          file.endsWith(".png") ? "nano.png" : "omni.mp4",
        );
        if (provider) body.append("provider", provider);
        const r = await fetch(base + path, { method: "POST", body });
        const p = await r.json();
        assert.ok(r.ok, JSON.stringify(p));
        return p;
      }
      let p = await upload("/projects", source);
      assert.deepEqual(
        p.scenes.map((s) => s.duration),
        [8, 1],
      );
      const id = p.id;
      const referenceHashes = [];
      for (const scene of p.scenes) {
        assert.ok(scene.storyboard.prompts.image);
        assert.ok(scene.storyboard.prompts.motion);
        const hashes = [];
        for (const edge of ["start", "end"]) {
          const r = await fetch(
            base + `/projects/${id}/storyboard/${scene.id}/references/${edge}`,
          );
          assert.equal(r.status, 200);
          const b = Buffer.from(await r.arrayBuffer());
          assert.equal(b[0], 255);
          assert.equal(b[1], 216);
          hashes.push(createHash("sha256").update(b).digest("hex"));
        }
        assert.notEqual(hashes[0], hashes[1]);
        referenceHashes.push(hashes);
      }
      const prompts = {
        image: "A consistent green environment based on my references",
        motion: "Slow camera push. Preserve the subject. No morphing.",
      };
      p = await request(
        `/projects/${id}/storyboard/0/prompts`,
        prompts,
        "PATCH",
      );
      assert.deepEqual(p.scenes[0].storyboard.prompts, prompts);
      p = await upload(`/projects/${id}/storyboard/0/import/image`, image);
      const imageFile = p.scenes[0].storyboard.image.file;
      p = await upload(
        `/projects/${id}/storyboard/0/import/video`,
        clip,
        "Omni Plus",
      );
      assert.equal(p.scenes[0].storyboard.video.provider, "Omni Plus");
      assert.equal(p.scenes[0].replacement, p.scenes[0].storyboard.video.file);
      assert.equal(p.scenes[0].storyboard.image.file, imageFile);
      assert.equal(
        (await fetch(base + `/projects/${id}/storyboard/0/media/image`)).status,
        200,
      );
      p = await upload(`/projects/${id}/storyboard/1/import/image`, image);
      p = await request(
        `/projects/${id}/timeline`,
        {
          scenes: [
            { id: 1, start: 8, duration: 1 },
            { id: 0, start: 1, duration: 3 },
          ],
        },
        "PATCH",
      );
      assert.equal(p.scenes[1].id, 0);
      assert.deepEqual(p.scenes[1].storyboard.prompts, prompts);
      assert.equal(p.scenes[1].storyboard.needsReview, true);
      assert.notEqual(
        p.scenes[1].storyboard.refs.start,
        p.scenes[0].storyboard.refs.start,
      );
      p = await upload(
        `/projects/${id}/storyboard/0/import/video`,
        clip,
        "Omni Flash",
      );
      assert.equal(p.scenes[1].id, 0);
      assert.equal(p.scenes[1].storyboard.video.provider, "Omni Flash");
      assert.equal(p.scenes[1].storyboard.needsReview, false);
      assert.equal(p.scenes[1].storyboard.image.file, imageFile);
      // Wrong media type cannot silently replace a scene.
      const bad = new FormData();
      bad.append("video", new Blob([await readFile(clip)]), "wrong.mp4");
      assert.equal(
        (
          await fetch(base + `/projects/${id}/storyboard/0/import/image`, {
            method: "POST",
            body: bad,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(base + `/projects/${id}/scenes/0/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "LIVE",
              kind: "video",
              prompt: "never call",
            }),
          })
        ).status,
        501,
      );
      await request(`/projects/${id}/export`, {});
      let job;
      for (let i = 0; i < 500; i++) {
        job = await (await fetch(base + `/projects/${id}/export`)).json();
        if (job.status !== "running") break;
        await sleep(100);
      }
      assert.equal(job.status, "done", JSON.stringify(job));
      const r = await fetch(base + `/projects/${id}/download`);
      assert.equal(r.status, 200);
      await mkdir("evidence", { recursive: true });
      const output = resolve("evidence/v3-1-output.mp4");
      await writeFile(output, Buffer.from(await r.arrayBuffer()));
      const info = await probe(output);
      assert.ok(Math.abs(info.duration - 4) < 0.1);
      assert.equal(info.audio, true);
      assert.equal(info.fps, 30);
      assert.equal(info.width, 320);
      assert.equal(info.height, 180);
      await run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
      const pixels = [];
      for (const t of [0.5, 2]) {
        const file = join(work, `pixel-${t}.rgb`);
        await run("ffmpeg", [
          "-y",
          "-v",
          "error",
          "-ss",
          String(t),
          "-i",
          output,
          "-frames:v",
          "1",
          "-vf",
          "crop=2:2:160:90,scale=1:1,format=rgb24",
          "-f",
          "rawvideo",
          file,
        ]);
        pixels.push([...(await readFile(file))]);
      }
      assert.ok(pixels[0][1] > 80 && pixels[0][0] < 30);
      assert.ok(pixels[1][0] > 200 && pixels[1][1] > 200 && pixels[1][2] < 30);
      await writeFile(
        "evidence/v3-1-validation.json",
        JSON.stringify(
          {
            testedAt: new Date().toISOString(),
            source: {
              duration: 9,
              media: "local moving test pattern and 440 Hz audio",
            },
            sourceSplitSeconds: [8, 1],
            referenceHashes,
            output: info,
            finalOrder: p.scenes.map((s) => ({
              id: s.id,
              start: s.start,
              duration: s.duration,
              kind: s.kind,
              provider:
                s.storyboard.video?.provider || s.storyboard.image?.provider,
            })),
            pixels,
            checks: [
              "automatic first/last JPEG references differ",
              "image and motion prompts edited and persisted",
              "separate Nano image retained after Omni video import",
              "import routed to stable scene ID after reorder",
              "trim refreshed references and flagged old media for review",
              "wrong media kind rejected",
              "LIVE generation blocked 501",
              "48fps portrait 1s clip looped and normalized to 30fps landscape 3s",
              "4 second H264/AAC MP4 downloaded and fully decoded",
              "green image and yellow imported clip pixels verified",
            ],
            externalGeneration:
              "NOT RUN; media fixtures generated locally, not by Google Flow",
            paidCreditsUsed: 0,
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

test('audio outlasts video: do not create a phantom storyboard scene',async()=>{
 const work=await mkdtemp(join(tmpdir(),'studio-v31-padding-')),source=join(work,'source.mp4');
 await run('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=blue:s=160x90:r=30:d=8','-f','lavfi','-i','sine=frequency=440:duration=9','-c:v','libx264','-threads','1','-c:a','aac',source]);
 const info=await probe(source);assert.equal(info.duration,8);
 const {detect}=await import('../server/media.mjs');const scenes=await detect(source,info.duration);assert.equal(scenes.length,1);
 const {ensureStoryboard}=await import('../server/storyboard.mjs');const p={...info,scenes};await ensureStoryboard(p,work);for(const name of Object.values(p.scenes[0].storyboard.refs))assert.ok((await readFile(join(work,name))).length>100);
});
