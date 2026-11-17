import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  mkdir,
  utimes,
  open,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { run, probe } from "../server/media.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  "V3 timeline + mock image/video + manual Flow + real MP4 + protection",
  { timeout: 180000 },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "studio-v3-")),
      source = join(work, "source.mp4"),
      image = join(work, "flow.png"),
      video = join(work, "flow.mp4");
    const segments = [];
    for (const [i, color, tone, duration] of [
      [0, "black", 330, 6],
      [1, "red", 880, 6],
      [2, "blue", 440, 5],
    ]) {
      const file = join(work, `segment-${i}.mp4`);
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=${color}:s=320x180:r=30:d=${duration}`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${tone}:sample_rate=48000:duration=${duration}`,
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        file,
      ]);
      segments.push(`file '${file}'`);
    }
    await writeFile(join(work, "list.txt"), segments.join("\n"));
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      join(work, "list.txt"),
      "-c",
      "copy",
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
      "color=yellow:s=180x320:r=24:d=1",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
    const data = join(work, "data"),
      port = 43129;
    const server = spawn(process.execPath, ["server/index.mjs"], {
      env: { ...process.env, PORT: String(port), DATA_DIR: data },
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
        return { status: r.status, data: await r.json() };
      };
      async function upload(path, file, origin = "manual") {
        const body = new FormData();
        body.append(
          "video",
          new Blob([await readFile(file)]),
          file.endsWith(".png") ? "flow.png" : "flow.mp4",
        );
        body.append("origin", origin);
        const r = await fetch(base + path, { method: "POST", body });
        return { status: r.status, data: await r.json() };
      }
      const config = await (await fetch(base + "/config")).json();
      assert.equal(config.limits.uploadBytes, 50 * 1024 * 1024);
      assert.equal(config.providers[1].generation, false);
      let r = await upload("/projects", source);
      assert.equal(r.status, 201, JSON.stringify(r.data));
      let p = r.data;
      assert.equal(p.scenes.length, 3);
      const [a, b, c] = p.scenes;
      assert.equal(
        (
          await request(`/projects/${p.id}/scenes/${a.id}/generate`, {
            mode: "LIVE",
            kind: "video",
            prompt: "never send",
          })
        ).status,
        501,
      );
      r = await request(`/projects/${p.id}/scenes/${a.id}/generate`, {
        mode: "MOCK",
        kind: "image",
        prompt: "studio",
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      p = r.data;
      assert.equal(p.scenes[0].networkCalls, 0);
      assert.equal(p.scenes[0].kind, "image");
      r = await request(`/projects/${p.id}/scenes/${b.id}/generate`, {
        mode: "MOCK",
        kind: "video",
        prompt: "local-video",
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.scenes[1].kind, "video");
      r = await upload(
        `/projects/${p.id}/scenes/${b.id}`,
        image,
        "google-flow",
      );
      assert.equal(r.status, 200);
      assert.equal(r.data.scenes[1].origin, "google-flow");
      assert.equal(r.data.scenes[1].kind, "image");
      r = await upload(
        `/projects/${p.id}/scenes/${c.id}`,
        video,
        "google-flow",
      );
      assert.equal(r.status, 200);
      const timeline = [
        { id: c.id, start: 12, duration: 2 },
        { id: a.id, start: 1, duration: 1 },
        { id: b.id, start: 6, duration: 2 },
      ];
      assert.equal(
        (
          await request(
            `/projects/${p.id}/timeline`,
            { scenes: [{ id: a.id, start: -1, duration: 1 }] },
            "PATCH",
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            `/projects/${p.id}/timeline`,
            { scenes: [{ id: a.id, start: 0, duration: 9 }] },
            "PATCH",
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            `/projects/${p.id}/timeline`,
            { scenes: [timeline[0], timeline[0]] },
            "PATCH",
          )
        ).status,
        400,
      );
      r = await request(
        `/projects/${p.id}/timeline`,
        { scenes: timeline },
        "PATCH",
      );
      assert.equal(r.status, 200);
      assert.deepEqual(
        r.data.scenes.map((s) => s.id),
        [c.id, a.id, b.id],
      );
      assert.equal((await request(`/projects/${p.id}/export`, {})).status, 202);
      assert.equal(
        (
          await request(
            `/projects/${p.id}/timeline`,
            { scenes: timeline },
            "PATCH",
          )
        ).status,
        429,
      );
      let job;
      for (let i = 0; i < 1000; i++) {
        job = await (await fetch(base + `/projects/${p.id}/export`)).json();
        if (job.status !== "running") break;
        await sleep(100);
      }
      assert.equal(job.status, "done", JSON.stringify(job));
      const out = await fetch(base + `/projects/${p.id}/download`);
      assert.equal(out.status, 200);
      await mkdir("evidence", { recursive: true });
      const output = resolve("evidence/v3-output.mp4");
      await writeFile(output, Buffer.from(await out.arrayBuffer()));
      const info = await probe(output);
      assert.ok(Math.abs(info.duration - 5) < 0.12);
      assert.equal(info.audio, true);
      await run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
      async function pixel(t) {
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
        return [...(await readFile(file))];
      }
      const yellow = await pixel(1);
      assert.ok(
        yellow[0] > 200 && yellow[1] > 200 && yellow[2] < 30,
        JSON.stringify(yellow),
      );
      const mockPixel = await pixel(2.5);let hash=0;for(const c of 'studio')hash=(hash*31+c.charCodeAt(0))>>>0;const mockColor=[hash>>>16&255,hash>>>8&255,hash&255];assert.ok(mockPixel.every((v,i)=>Math.abs(v-mockColor[i])<6),JSON.stringify({mockPixel,mockColor}));
    const green = await pixel(4);
      assert.ok(green[1] > 80 && green[0] < 30 && green[2] < 30);
      const frequencies = [];
      for (const [time, expected] of [
        [0.5, 440],
        [2.2, 330],
        [3.5, 880],
      ]) {
        const file = join(work, `audio-${time}.raw`);
        await run("ffmpeg", [
          "-y",
          "-v",
          "error",
          "-ss",
          String(time),
          "-t",
          "0.5",
          "-i",
          output,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "48000",
          "-f",
          "f32le",
          file,
        ]);
        const buf = await readFile(file);
        let crosses = 0;
        for (let i = 4; i < buf.length; i += 4)
          if (buf.readFloatLE(i - 4) < 0 && buf.readFloatLE(i) >= 0) crosses++;
        const hz = crosses / 0.5;
        assert.ok(Math.abs(hz - expected) < 5, `${hz} != ${expected}`);
        frequencies.push({ time, hz, expected });
      }
      const bad = new FormData();
      bad.append("video", new Blob(["not mp4"]), "bad.mp4");
      assert.equal(
        (await fetch(base + "/projects", { method: "POST", body: bad })).status,
        400,
      );
      const huge = new FormData();
      huge.append(
        "video",
        new Blob([new Uint8Array(50 * 1024 * 1024 + 1)]),
        "large.mp4",
      );
      assert.equal(
        (await fetch(base + "/projects", { method: "POST", body: huge }))
          .status,
        413,
      );
      const foreign = await fetch(base + "/projects", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      });
      assert.equal(foreign.status, 403);
      assert.equal((await readdir(join(data, "uploads"))).length, 0);
      assert.equal(
        (await fetch(base + `/projects/${p.id}/source`)).status,
        200,
      );
      const cleanupFiles = await readdir(join(data, p.id));
      assert.ok(!cleanupFiles.some((x) => x.startsWith("part-")));

      assert.equal(
        (await fetch(base + `/projects/${p.id}`, { method: "DELETE" })).status,
        200,
      );
      assert.equal((await fetch(base + `/projects/${p.id}`)).status, 404);
      // Quotas are exercised against real persisted projects, then stale data is removed.
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const q = await upload("/projects", video);
        assert.equal(q.status, 201);
        ids.push(q.data.id);
      }
      assert.equal((await upload("/projects", video)).status, 429);
      const quota = join(data, "quota-test");
      const file = await open(quota, "w");
      await file.truncate(350 * 1024 * 1024);
      await file.close();
      assert.equal(
        (await request(`/projects/${ids[0]}/export`, {})).status,
        507,
      );
      assert.equal(
        (await fetch(base + `/projects/${ids.pop()}`, { method: "DELETE" }))
          .status,
        200,
      );
      await unlink(quota);
      const oldTime = new Date(Date.now() - 7 * 3600000);
      await utimes(join(data, ids[0], "project.json"), oldTime, oldTime);
      assert.equal(
        (await request(`/projects/${ids[0]}/export`, {})).status,
        404,
      );
      for (const id of ids.slice(1))
        assert.equal(
          (await fetch(base + `/projects/${id}`, { method: "DELETE" })).status,
          200,
        );
      assert.equal((await readdir(join(data, "uploads"))).length, 0);
      await writeFile(
        "evidence/v3-validation.json",
        JSON.stringify(
          {
            testedAt: new Date().toISOString(),
            output: info,
            timeline,
            frequencies,
            checks: [
              "MOCK PNG and MP4 generated locally",
              "LIVE generation rejected 501",
              "manual Flow PNG and MP4 imported",
              "timeline reorder and trim persisted",
              "yellow video, mock image and green Flow image pixels verified",
              "source audio reordered: 440 → 330 → 880 Hz",
              "full MP4 decoded",
              "50MB upload rejected with 413 and cleaned",
              "invalid signatures and cross-site writes rejected",
              "global concurrent mutation rejected 429",
              "temporary render parts deleted",
              "5-project quota enforced",
              "disk watermark rejects writes; deletion still works",
              "expired projects cleaned after 6 hours",
            ],
            networkCalls: 0,
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

test("optional password protects media/UI while health remains available", async () => {
  const work = await mkdtemp(join(tmpdir(), "studio-v3-auth-")),
    password = randomUUID();
  const server = spawn(process.execPath, ["server/index.mjs"], {
    env: {
      ...process.env,
      PORT: "43131",
      DATA_DIR: work,
      STUDIO_PASSWORD: password,
    },
    stdio: "ignore",
  });
  const base = "http://127.0.0.1:43131";
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/api/health")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await sleep(100);
    }
    assert.ok(ready);
    assert.equal((await fetch(base + "/api/config")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/config", {
          headers: {
            authorization:
              "Basic " + Buffer.from("studio:wrong").toString("base64"),
          },
        })
      ).status,
      401,
    );
    const r = await fetch(base + "/api/config", {
      headers: {
        authorization:
          "Basic " + Buffer.from("studio:" + password).toString("base64"),
      },
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).authentication, true);
  } finally {
    server.kill("SIGTERM");
  }
});
