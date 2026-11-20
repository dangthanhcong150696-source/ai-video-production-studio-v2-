// Workstream 4 — real-clip save, wipe, restore, and re-export QC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { run } from "../server/media.mjs";
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CLIPS = [
  ["Woman_smiling_in_car_interior_59b4e7c1", "Scene 0"],
  ["Woman_turning_head_portrait_video_a1321114", "Scene 1"],
  ["Woman_turning_and_smiling_5f8e1264", "Scene 2"],
];

test(
  "V3.2 QC: real clips survive wipe via local storage and a bundle, then re-export",
  { timeout: 600000 },
  async () => {
    const report = {
      startedAt: new Date().toISOString(),
      ffmpeg: "",
      fixtures: [],
      source: null,
      scenes: null,
      drive: null,
      localRestore: null,
      bundleRestore: null,
      exports: {},
      endFrames: null,
      referenceExport: null,
      checks: [],
    };
    const work = await mkdtemp(join(tmpdir(), "studio-v32-qc-"));
    const data = join(work, "data");
    const saves = join(work, "saves");
    let server;
    const check = (name, result, detail) => {
      report.checks.push({ name, result, detail });
      if (result === "FAIL") throw new Error(`${name}: ${JSON.stringify(detail)}`);
    };
    try {
      report.ffmpeg = (await run("ffmpeg", ["-version"])).out.split("\n")[0];
      const clips = [];
      for (const [prefix, label] of CLIPS) {
        const file = await findClip(prefix);
        clips.push(file);
        report.fixtures.push({ label, prefix, file: basename(file), ...(await inspect(file)) });
      }
      const source = join(work, "source.mp4");
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-i",
        clips[0],
        "-i",
        clips[1],
        "-i",
        clips[2],
        "-filter_complex",
        "[0:v]trim=duration=8,setpts=PTS-STARTPTS,fps=24[v0];[1:v]trim=duration=8,setpts=PTS-STARTPTS,fps=24[v1];[2:v]trim=duration=8,setpts=PTS-STARTPTS,fps=24[v2];[0:a]atrim=duration=8,asetpts=PTS-STARTPTS[a0];[1:a]atrim=duration=8,asetpts=PTS-STARTPTS[a1];[2:a]atrim=duration=8,asetpts=PTS-STARTPTS[a2];[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-threads",
        "1",
        "-r",
        "24",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-t",
        "24",
        source,
      ]);
      report.source = await inspect(source);
      check(
        "source is 720x1280 with audio near 24s",
        report.source.width === 720 &&
          report.source.height === 1280 &&
          report.source.audio &&
          report.source.duration > 23.5 &&
          report.source.duration < 24.5
          ? "PASS"
          : "FAIL",
        report.source,
      );
      const port = 43143;
      const env = { ...process.env, PORT: String(port), DATA_DIR: data, SAVE_DIR: saves };
      for (const key of [
        "STORAGE_BACKEND",
        "GOOGLE_DRIVE_FOLDER_ID",
        "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON",
        "GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE",
        "GOOGLE_DRIVE_CLIENT_ID",
        "GOOGLE_DRIVE_CLIENT_SECRET",
        "GOOGLE_DRIVE_REFRESH_TOKEN",
      ])
        delete env[key];
      server = spawn(process.execPath, ["server/index.mjs"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let logs = "";
      server.stderr.on("data", (chunk) => (logs += chunk));
      const base = `http://127.0.0.1:${port}/api`;
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/health")).ok) break;
        } catch {
          /* retry */
        }
        if (i === 99) throw new Error(logs);
        await sleep(100);
      }
      const project = await postFile(base + "/projects", source);
      report.scenes = project.scenes.map((scene) => ({
        id: scene.id,
        start: scene.start,
        duration: scene.duration,
      }));
      const timelineSeconds = project.scenes.reduce((sum, scene) => sum + scene.duration, 0);
      check(
        "detected timeline is 3 scenes with ids 0,1,2",
        project.scenes.length === 3 &&
          project.scenes.every((scene, index) => scene.id === index) &&
          timelineSeconds > 23.5 &&
          timelineSeconds < 24.5
          ? "PASS"
          : "FAIL",
        { scenes: report.scenes, timelineSeconds },
      );
      let current = project;
      for (const scene of project.scenes)
        current = await postFile(
          `${base}/projects/${project.id}/scenes/${scene.id}`,
          clips[scene.id],
        );
      const face = join(work, "face.jpg");
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-ss",
        "1",
        "-i",
        clips[0],
        "-frames:v",
        "1",
        face,
      ]);
      const character = await postCharacter(base + "/characters", face);
      check(
        "unknown rights are flagged",
        character.rightsFlagged === true && character.rightsStatus === "unknown"
          ? "PASS"
          : "FAIL",
        { rightsStatus: character.rightsStatus, rightsFlagged: character.rightsFlagged },
      );
      current = await postJson(`${base}/projects/${project.id}/character`, {
        characterId: character.id,
      });
      const drive = await postJson(`${base}/projects/${project.id}/save`, {
        backend: "drive",
      }, true);
      report.drive = {
        configured: drive.body.configured,
        status: drive.status,
        error: drive.body.error,
        scope: "https://www.googleapis.com/auth/drive",
      };
      check(
        "Google Drive without credentials",
        drive.status === 424 && drive.body.configured === false ? "BLOCKED" : "FAIL",
        report.drive,
      );
      await renderProject(base, project.id);
      const originalExport = join(work, "original-export.mp4");
      await download(`${base}/projects/${project.id}/download`, originalExport);
      report.exports.original = await inspect(originalExport);
      report.endFrames = await endFrames(originalExport, clips, work);
      check(
        "8.04s clips in 8.00s scenes do not snap the last frame back to the first",
        report.endFrames.ok ? "PASS" : "FAIL",
        report.endFrames,
      );
      report.referenceExport = await findReference();
      check(
        "ORDER_008F_FINAL comparison",
        report.referenceExport.available ? "PASS" : "BLOCKED",
        report.referenceExport,
      );
      const saved = await postJson(`${base}/projects/${project.id}/save`, {
        backend: "local",
      });
      assert.equal(saved.saved, true);
      const manifest = JSON.parse(
        await readFile(join(saves, project.id, "manifest.json"), "utf8"),
      );
      check(
        "manifest keeps 0-based scenes, timeline, hashes and flagged character",
        manifest.manifestVersion === 1 &&
          manifest.project.timeline.every(
            (mark, index) =>
              mark.sceneId === manifest.project.scenes[index].id &&
              mark.sceneId === index,
          ) &&
          manifest.project.scenes.every((scene) =>
            scene.media.every((media) => media.sha256 && media.size > 0 && media.mime),
          ) &&
          manifest.project.characterLock.rightsFlagged === true &&
          manifest.project.scenes.every((scene) =>
            scene.effectivePrompts.image.startsWith("LOCKED QC same woman"),
          )
          ? "PASS"
          : "FAIL",
        {
          ids: manifest.project.scenes.map((scene) => scene.id),
          timeline: manifest.project.timeline,
          rightsFlagged: manifest.project.characterLock.rightsFlagged,
        },
      );
      const bundlePath = join(work, "bundle.zip");
      await download(`${base}/projects/${project.id}/bundle`, bundlePath);
      const zipRead = await pythonZip(bundlePath);
      check("Python zipfile reads the exported bundle", zipRead.ok ? "PASS" : "FAIL", zipRead);
      const fingerprint = await diskFingerprint(data, project.id, manifest);
      await wipe(data);
      const empty = await (await fetch(base + "/projects")).json();
      check(
        "wiped live disk lists no projects",
        empty.projects.length === 0 ? "PASS" : "FAIL",
        empty,
      );
      const restored = await postJson(`${base}/saved/${project.id}/restore`, {
        backend: "local",
      });
      report.localRestore = await compareProject(restored, manifest, data);
      check("restore from local storage", report.localRestore.ok ? "PASS" : "FAIL", report.localRestore);
      await renderProject(base, project.id);
      const localExport = join(work, "local-reexport.mp4");
      await download(`${base}/projects/${project.id}/download`, localExport);
      report.exports.afterLocalRestore = await compareMedia(originalExport, localExport);
      check(
        "re-export after local restore",
        report.exports.afterLocalRestore.ok ? "PASS" : "FAIL",
        report.exports.afterLocalRestore,
      );
      await wipe(data);
      const fromBundle = await postFile(base + "/bundles", bundlePath, "bundle");
      report.bundleRestore = await compareProject(fromBundle, manifest, data);
      check("restore from bundle", report.bundleRestore.ok ? "PASS" : "FAIL", report.bundleRestore);
      assert.deepEqual(
        fingerprint.sceneMedia,
        report.localRestore.sceneMedia.map((scene) => scene.media.map((media) => media.sha256)),
      );
      assert.deepEqual(
        fingerprint.sceneMedia,
        report.bundleRestore.sceneMedia.map((scene) => scene.media.map((media) => media.sha256)),
      );
      await renderProject(base, project.id);
      const bundleExport = join(work, "bundle-reexport.mp4");
      await download(`${base}/projects/${project.id}/download`, bundleExport);
      report.exports.afterBundleRestore = await compareMedia(originalExport, bundleExport);
      check(
        "re-export after bundle restore",
        report.exports.afterBundleRestore.ok ? "PASS" : "FAIL",
        report.exports.afterBundleRestore,
      );
      report.finishedAt = new Date().toISOString();
    } catch (error) {
      report.finishedAt = new Date().toISOString();
      report.fatal = error.stack || error.message;
      if (!report.checks.some((item) => item.result === "FAIL"))
        report.checks.push({ name: "qc run", result: "FAIL", detail: error.message });
      throw error;
    } finally {
      server?.kill("SIGTERM");
      const jsonPath = join(process.cwd(), "evidence/v3-2-qc.json");
      await mkdir(join(process.cwd(), "evidence"), { recursive: true });
      await writeFile(jsonPath, JSON.stringify(report, null, 2));
      await writeFile(
        join(process.cwd(), "docs/V3_2_QC_REPORT.md"),
        renderReport(report),
      );
    }
  },
);

function probeRow(label, probe) {
  if (!probe) return `| ${label} | not measured | | | | | | |`;
  return `| ${label} | ${probe.sha256} | ${probe.duration} | ${probe.width}x${probe.height} | ${probe.fps} | ${probe.frames} | ${probe.audio ? "yes" : "no"} | ${probe.size} |`;
}

function sampleTable(measurement) {
  if (!measurement?.samples) return "";
  return [
    "",
    "| timestamp (s) | SSIM | PSNR |",
    "| --- | --- | --- |",
    ...measurement.samples.map(
      (sample) => `| ${sample.time} | ${sample.ssim} | ${sample.psnr} |`,
    ),
    "",
    `Export sha256 match: **${measurement.sha256Match ? "yes" : "no"}**.`,
  ].join("\n");
}

function renderReport(report) {
  const line = (check) =>
    `- **${check.result}** ${check.name}` +
    (check.detail ? `\n\n\`\`\`json\n${JSON.stringify(check.detail, null, 2)}\n\`\`\`` : "");
  const exportBlock = (title, measurement) => {
    if (!measurement) return `## ${title}\n\nNot measured.\n`;
    return `## ${title}\n\n${sampleTable(measurement)}\n\n${"```json\n"}${JSON.stringify(measurement, null, 2)}\n\`\`\`\n`;
  };
  const original = report.exports.original;
  const local = report.exports.afterLocalRestore;
  const bundle = report.exports.afterBundleRestore;
  return `# V3.2 QC report

Generated by \`tests/v3-2-qc.test.mjs\` at ${report.finishedAt || report.startedAt}.
FFmpeg: ${report.ffmpeg || "unknown"}.

The three portrait clips are read at test time and are not committed. Stream-copy concatenation leaves each cut at about 8.043s because the audio track is 8.043s, and the V3.1 splitter then breaks an 8.000s cap into extra scenes. The fixture therefore trims each real clip to its 8.000s video track, concatenates at constant 24 fps, and expects three scenes.

## Result summary

| Check | Result |
| --- | --- |
${report.checks.map((check) => `| ${check.name} | ${check.result} |`).join("\n")}

## Export comparison

| Export | sha256 | duration (s) | resolution | fps | frames | audio | size |
| --- | --- | --- | --- | --- | --- | --- | --- |
${probeRow("original", original)}
${probeRow("after local restore", local?.after)}
${probeRow("after bundle restore", bundle?.after)}

${sampleTable(local) ? `### SSIM / PSNR after local restore\n${sampleTable(local)}` : ""}
${sampleTable(bundle) ? `### SSIM / PSNR after bundle restore\n${sampleTable(bundle)}` : ""}

${endFrameTable(report.endFrames)}

${report.checks.map(line).join("\n\n")}

## Fixtures

\`\`\`json
${JSON.stringify(report.fixtures, null, 2)}
\`\`\`

## Concatenated source

\`\`\`json
${JSON.stringify(report.source, null, 2)}
\`\`\`

## Detected scenes

\`\`\`json
${JSON.stringify(report.scenes, null, 2)}
\`\`\`

## Google Drive

${report.drive ? `Status ${report.drive.status}. ${report.drive.error || ""}` : "Not measured."}

Live Drive was not called. Scope required when credentials exist: \`${report.drive?.scope || "https://www.googleapis.com/auth/drive"}\`.

${exportBlock("Original export", report.exports.original)}
${exportBlock("Re-export after local restore", report.exports.afterLocalRestore)}
${exportBlock("Re-export after bundle restore", report.exports.afterBundleRestore)}
${report.fatal ? `## Fatal\n\n\`\`\`\n${report.fatal}\n\`\`\`\n` : ""}
`;
}

function endFrameTable(endFrames) {
  if (!endFrames?.scenes) return "";
  return [
    "## Scene-end frames",
    "",
    "Each scene is 8.00s at 30fps. The last frame is index 239 inside the scene (about 7.967s). A looped clip would make that frame match the clip's first frame.",
    "",
    "| scene | output frame | SSIM vs scene start | SSIM vs clip start | SSIM vs clip end (~7.9s) |",
    "| --- | --- | --- | --- | --- |",
    ...endFrames.scenes.map(
      (scene) =>
        `| ${scene.index} | ${scene.frame} | ${scene.versusFirst} | ${scene.versusSourceFirst} | ${scene.versusSourceEnd} |`,
    ),
    "",
    `ORDER_008F_FINAL: ${endFrames.reference || "not used"}.`,
    "",
  ].join("\n");
}

async function grabFrame(file, dest, { time, frame } = {}) {
  const select = Number.isInteger(frame)
    ? ["-vf", `select=eq(n\\,${frame})`, "-frames:v", "1"]
    : ["-ss", String(time), "-frames:v", "1"];
  await run("ffmpeg", ["-y", "-v", "error", "-i", file, ...select, dest]);
}

async function ssimAt(left, right, scaleSecond) {
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
  if (!Number.isFinite(value)) throw new Error(result.err.slice(-500));
  return value;
}

async function endFrames(exportFile, clips, work) {
  const scenes = [];
  for (let index = 0; index < clips.length; index++) {
    const dir = join(work, `endframe-${index}`);
    await mkdir(dir, { recursive: true });
    const frame = index * 240 + 239;
    const last = join(dir, "last.png");
    const first = join(dir, "first.png");
    const srcFirst = join(dir, "src-first.png");
    const srcLast = join(dir, "src-last.png");
    await grabFrame(exportFile, last, { frame });
    await grabFrame(exportFile, first, { frame: index * 240 });
    await grabFrame(clips[index], srcFirst, { time: 0.1 });
    await grabFrame(clips[index], srcLast, { time: 7.9 });
    const versusFirst = await ssimAt(last, first, false);
    const versusSourceFirst = await ssimAt(last, srcFirst, true);
    const versusSourceEnd = await ssimAt(last, srcLast, true);
    scenes.push({
      index,
      frame,
      time: Number((index * 8 + 239 / 30).toFixed(3)),
      versusFirst,
      versusSourceFirst,
      versusSourceEnd,
    });
  }
  return {
    ok: scenes.every(
      (scene) =>
        scene.versusFirst < 0.85 &&
        scene.versusSourceEnd > scene.versusSourceFirst + 0.05,
    ),
    scenes,
    reference: "ORDER_008F_FINAL is not in this workspace",
  };
}

async function findReference() {
  const roots = [
    process.env.V32_FIXTURE_DIR,
    "/home/ubuntu/.cursor/projects/workspace/uploads",
    join(process.cwd(), "uploads"),
    join(process.cwd(), "evidence"),
  ].filter(Boolean);
  for (const root of roots) {
    let names = [];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    const match = names.find((name) => name.includes("ORDER_008F_FINAL"));
    if (match) return { available: true, file: join(root, match) };
  }
  return {
    available: false,
    reason: "ORDER_008F_FINAL is not in this workspace or the fixture directory",
  };
}

async function pythonZip(zipPath) {
  const script = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as bundle:
    bad = bundle.testzip()
    if bad:
        raise SystemExit("corrupt " + bad)
    rows = []
    for info in bundle.infolist():
        year, month, day = info.date_time[:3]
        if year < 1980 or not 1 <= month <= 12 or not 1 <= day <= 31:
            raise SystemExit("invalid DOS date " + str(info.date_time) + " " + info.filename)
        bundle.read(info.filename)
        rows.append({"name": info.filename, "date": list(info.date_time)})
print(json.dumps(rows))
`;
  try {
    const { stdout } = await exec("python3", ["-c", script, zipPath]);
    return { ok: true, entries: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message) };
  }
}

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
  throw new Error(`Missing real clip ${prefix}. Set V32_FIXTURE_DIR.`);
}

async function inspect(file) {
  const { out } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "format=duration,size",
      "-show_streams",
      "-of",
      "json",
      file,
    ],
    60000,
  );
  const info = JSON.parse(out);
  const video = info.streams.find((stream) => stream.codec_type === "video");
  const [num, den] = (video.avg_frame_rate || "0/1").split("/").map(Number);
  return {
    sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
    size: Number(info.format.size),
    duration: Number(video.duration || info.format.duration),
    width: video.width,
    height: video.height,
    fps: den ? num / den : 0,
    frames: Number(video.nb_read_frames || video.nb_frames) || null,
    audio: info.streams.some((stream) => stream.codec_type === "audio"),
    videoCodec: video.codec_name,
    audioCodec: info.streams.find((stream) => stream.codec_type === "audio")?.codec_name || null,
  };
}

async function compareMedia(original, next) {
  const before = await inspect(original);
  const after = await inspect(next);
  const samples = [];
  for (const time of [1, 4, 9, 12, 17, 21]) {
    const left = join(tmpdir(), `qc-a-${time}.png`);
    const right = join(tmpdir(), `qc-b-${time}.png`);
    await run("ffmpeg", ["-y", "-v", "error", "-i", original, "-ss", String(time), "-frames:v", "1", left]);
    await run("ffmpeg", ["-y", "-v", "error", "-i", next, "-ss", String(time), "-frames:v", "1", right]);
    const ssim = await run("ffmpeg", ["-i", left, "-i", right, "-lavfi", "ssim", "-f", "null", "-"]);
    const psnr = await run("ffmpeg", ["-i", left, "-i", right, "-lavfi", "psnr", "-f", "null", "-"]);
    const ssimValue = Number((ssim.err.match(/All:([0-9.]+)/) || [])[1]);
    const psnrMatch = (psnr.err.match(/average:([0-9.inf]+)/i) || [])[1];
    const psnrValue = psnrMatch === "inf" ? Infinity : Number(psnrMatch);
    samples.push({ time, ssim: ssimValue, psnr: psnrMatch });
    await rm(left, { force: true });
    await rm(right, { force: true });
    if (!(ssimValue >= 0.98) || !(psnrValue >= 40 || psnrValue === Infinity)) {
      return { ok: false, before, after, samples };
    }
  }
  const ok =
    before.width === after.width &&
    before.height === after.height &&
    before.audio === true &&
    after.audio === true &&
    before.frames === after.frames &&
    Math.abs(before.duration - after.duration) <= 0.05 &&
    Math.abs(before.fps - after.fps) <= 0.05;
  return {
    ok,
    before,
    after,
    samples,
    sha256Match: before.sha256 === after.sha256,
  };
}

async function compareProject(project, manifest, data) {
  const sceneMedia = project.scenes.map((scene) => ({
    id: scene.id,
    start: scene.start,
    duration: scene.duration,
    media: scene.media.map((media) => ({
      role: media.role,
      sha256: media.sha256,
      size: media.size,
      mime: media.mime,
    })),
  }));
  const expected = manifest.project.scenes.map((scene) => ({
    id: scene.id,
    start: scene.start,
    duration: scene.duration,
    media: scene.media.map((media) => ({
      role: media.role,
      sha256: media.sha256,
      size: media.size,
      mime: media.mime,
    })),
  }));
  const hashes = [];
  for (const file of manifest.files) {
    const abs =
      file.place === "character"
        ? join(data, file.relativePath)
        : join(data, project.id, file.filename);
    const actual = createHash("sha256").update(await readFile(abs)).digest("hex");
    hashes.push({ path: file.path, expected: file.sha256, actual, match: actual === file.sha256 });
  }
  const ok =
    JSON.stringify(sceneMedia) === JSON.stringify(expected) &&
    hashes.every((item) => item.match) &&
    project.characterLock.rightsFlagged === true &&
    project.timeline.every((mark, index) => mark.sceneId === project.scenes[index].id);
  return { ok, sceneMedia, hashes, rightsFlagged: project.characterLock?.rightsFlagged };
}

async function diskFingerprint(data, id, manifest) {
  const sceneMedia = manifest.project.scenes.map((scene) =>
    scene.media.map((media) => media.sha256),
  );
  const source = createHash("sha256")
    .update(await readFile(join(data, id, "source.mp4")))
    .digest("hex");
  return { sceneMedia, source };
}

async function postFile(url, file, field = "video") {
  const body = new FormData();
  body.append(field, new Blob([await readFile(file)]), basename(file));
  const response = await fetch(url, { method: "POST", body });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(`${response.status} ${payload.error || JSON.stringify(payload)}`);
  return payload;
}

async function postJson(url, payload, raw = false) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (raw) return { status: response.status, body };
  if (!response.ok) throw new Error(`${response.status} ${body.error || JSON.stringify(body)}`);
  return body;
}

async function postCharacter(url, image) {
  const body = new FormData();
  body.append("name", "QC woman");
  body.append("rightsStatus", "unknown");
  body.append("rightsNote", "Fixture clip, rights not documented");
  body.append("face", "same woman in all three shots");
  body.append("hair", "dark shoulder-length");
  body.append("outfit", "as in the reference frame");
  body.append("lighting", "match the reference");
  body.append("promptPrefix", "LOCKED QC same woman");
  body.append("reference", new Blob([await readFile(image)]), basename(image));
  const response = await fetch(url, { method: "POST", body });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "character failed");
  return payload;
}

async function renderProject(base, id) {
  const started = await postJson(`${base}/projects/${id}/export`, {});
  if (started.status && started.status !== "running")
    throw new Error(JSON.stringify(started));
  for (let i = 0; i < 240; i++) {
    const job = await (await fetch(`${base}/projects/${id}/export`)).json();
    if (job.status === "done") return job;
    if (job.status === "failed") throw new Error(job.error || "export failed");
    await sleep(1000);
  }
  throw new Error("export timed out");
}

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await response.text());
  await writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

async function wipe(directory) {
  for (const name of await readdir(directory))
    await rm(join(directory, name), { recursive: true, force: true });
}
