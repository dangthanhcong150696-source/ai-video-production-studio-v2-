import { spawn } from "node:child_process";
import { open, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { limits, failure } from "./limits.mjs";
export function run(command, args, timeout = limits.processTimeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(failure("Xử lý quá thời gian giới hạn", 408));
    }, timeout);
    child.stdout.on("data", (b) => (out = (out + b).slice(-1000000)));
    child.stderr.on("data", (b) => (err = (err + b).slice(-1000000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve({ out, err })
        : reject(new Error(err.slice(-2000) || `${command}: ${code}`));
    });
  });
}
export async function probe(file) {
  const { out } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      file,
    ],
    10000,
  );
  const info = JSON.parse(out),
    video = info.streams.find((s) => s.codec_type === "video");
  // Audio/container padding must not create a scene after the final video frame.
  const videoDuration = Number(video?.duration);
  const duration = Number.isFinite(videoDuration)&&videoDuration>0 ? videoDuration : Number(info.format.duration);
  if (!video || !video.width || !video.height)
    throw failure("Không tìm thấy hình ảnh hợp lệ");
  return {
    duration,
    width: video.width,
    height: video.height,
    audio: info.streams.some((s) => s.codec_type === "audio"),
    fps:
      video.avg_frame_rate
        ?.split("/")
        .reduce((a, b) => Number(a) / Number(b)) || 0,
    frames: Number(video.nb_frames) > 0 ? Number(video.nb_frames) : null,
  };
}
export async function validateMedia(file, { source = false } = {}) {
  const handle = await open(file, "r");
  const bytes = Buffer.alloc(16);
  try {
    await handle.read(bytes, 0, 16, 0);
  } finally {
    await handle.close();
  }
  const kind = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image"
      : bytes.toString("ascii", 4, 8) === "ftyp"
        ? "video"
        : null;
  if (!kind || (source && kind !== "video"))
    throw failure("Chỉ nhận MP4 thực, PNG hoặc JPEG; nguồn phải là MP4");
  const info = await probe(file);
  if (
    info.width * info.height > limits.pixels ||
    Math.max(info.width, info.height) > 4096 ||
    info.width < 2 ||
    info.height < 2
  )
    throw failure("Độ phân giải tối đa tương đương 1920×1080");
  if (kind === "video" && info.fps > 60.1) throw failure("Video tối đa 60 fps");
  if (
    kind === "video" &&
    (!Number.isFinite(info.duration) ||
      info.duration <= 0 ||
      info.duration > limits.duration)
  )
    throw failure(`Video phải dài hơn 0 và tối đa ${limits.duration} giây`);
  return { ...info, kind, extension: kind === "video" ? ".mp4" : bytes[0] === 255 ? ".jpg" : ".png" };
}
export async function detect(file, duration) {
  const { err } = await run("ffmpeg", [
    "-hide_banner",
    "-threads",
    "1",
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    file,
    "-an",
    "-filter_threads",
    "1",
    "-vf",
    "scale=320:-2,select='gt(scene,0.35)',showinfo",
    "-fps_mode",
    "vfr",
    "-f",
    "null",
    "-",
  ]);
  const cuts = [...err.matchAll(/pts_time:([\d.]+)/g)]
    .map((m) => Number(m[1]))
    .filter((t) => t > 0.25 && t < duration - 0.25);
  let start = 0;
  const scenes = [];
  for (const end of [...new Set(cuts), duration].sort((a, b) => a - b)) {
    while (end - start > 8.000001) {
      scenes.push({ start, duration: 8 });
      start += 8;
    }
    if (end - start > 0.001) {
      scenes.push({ start, duration: end - start });
      start = end;
    }
  }
  if (scenes.length > limits.maxScenes)
    throw failure("Quá nhiều cảnh; hãy nhập clip ngắn hơn");
  return scenes.map((s, i) => ({
    ...s,
    id: i,
    replacement: null,
    kind: "video",
    origin: "source",
  }));
}
export function editTimeline(p, scenes) {
  if (
    !Array.isArray(scenes) ||
    !scenes.length ||
    scenes.length > limits.maxScenes
  )
    throw failure("Timeline cần 1–60 cảnh");
  const seen = new Set();
  return scenes.map((s) => {
    const original = p.scenes.find((x) => x.id === s.id);
    if (!original || seen.has(s.id))
      throw failure("ID cảnh không hợp lệ hoặc bị trùng");
    seen.add(s.id);
    if (
      typeof s.start !== "number" ||
      typeof s.duration !== "number" ||
      !Number.isFinite(s.start) ||
      !Number.isFinite(s.duration) ||
      s.start < 0 ||
      s.duration < 0.1 ||
      s.duration > 8 ||
      s.start + s.duration > p.duration + 0.001
    )
      throw failure("Trim phải nằm trong nguồn, thời lượng 0.1–8 giây");
    return { ...original, start: s.start, duration: s.duration };
  });
}
// stream_loop restarts at frame 0. A clip that already covers the scene is trimmed instead.
export function videoReplacementArgs(file, mediaDuration, sceneDuration) {
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0)
    throw failure("Không đọc được thời lượng clip thay thế");
  if (mediaDuration >= sceneDuration) return ["-i", file];
  return ["-stream_loop", "-1", "-i", file];
}
export function sceneVideoFilter(width, height, { holdLastFrame = false, duration = 0 } = {}) {
  const geometry = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  if (!holdLastFrame) return `${geometry},fps=30,format=yuv420p`;
  // Trim before fps so rate conversion cannot sample a looped first frame.
  // Clone at most one 30fps frame when the trimmed clip ends slightly early.
  return `trim=duration=${duration},setpts=PTS-STARTPTS,${geometry},fps=30,tpad=stop_mode=clone:stop_duration=0.034,format=yuv420p`;
}
export async function render(
  project,
  dir,
  onProgress,
  checkQuota = async () => {},
) {
  const deadline = Date.now() + 180000;
  const remaining = () =>
    Math.max(1, Math.min(limits.processTimeout, deadline - Date.now()));
  const parts = [];
  const ratio = Math.min(
    1,
    1280 / Math.max(project.width, project.height),
    720 / Math.min(project.width, project.height),
  );
  const w = Math.max(2, Math.floor((project.width * ratio) / 2) * 2),
    h = Math.max(2, Math.floor((project.height * ratio) / 2) * 2);
  const scenes = project.scenes.map((s) => ({
    ...s,
    duration: Math.round(s.duration * 30) / 30,
  }));
  const duration = scenes.reduce((n, s) => n + s.duration, 0);
  const temps = [];
  try {
    for (const [index, scene] of scenes.entries()) {
      await checkQuota();
      if (Date.now() > deadline) throw failure("Render quá 3 phút", 408);
      const name = `part-${index}.mp4`,
        part = join(dir, name);
      temps.push(part);
      let input;
      let holdLastFrame = false;
      if (!scene.replacement) {
        input = ["-ss", String(scene.start), "-i", join(dir, "source.mp4")];
      } else if (scene.kind === "image") {
        input = ["-loop", "1", "-i", join(dir, scene.replacement)];
      } else {
        const clip = join(dir, scene.replacement);
        const mediaDuration = (await probe(clip)).duration;
        input = videoReplacementArgs(clip, mediaDuration, scene.duration);
        holdLastFrame = mediaDuration >= scene.duration;
      }
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
          ...input,
          "-t",
          String(scene.duration),
          "-map",
          "0:v:0",
          "-an",
          "-filter_threads",
          "1",
          "-vf",
          sceneVideoFilter(w, h, {
            holdLastFrame,
            duration: scene.duration,
          }),
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-threads",
          "1",
          "-fs",
          "16777216",
          part,
        ],
        remaining(),
      );
      const measured = await probe(part);
      if (Math.abs(measured.duration - scene.duration) > 0.1)
        throw failure("Cảnh vượt giới hạn kích thước xuất");
      parts.push(`file '${name}'`);
      onProgress(Math.round(((index + 1) / scenes.length) * 85));
    }
    await checkQuota();
    const list = join(dir, "concat.txt");
    temps.push(list);
    await writeFile(list, parts.join("\n"));
    const audio = project.audio
      ? [
          "-filter_complex_threads",
          "1",
          "-filter_complex",
          scenes
            .map(
              (s, i) =>
                `[1:a:0]atrim=start=${s.start}:duration=${s.duration},asetpts=PTS-STARTPTS,apad,atrim=duration=${s.duration}[a${i}]`,
            )
            .join(";") +
            ";" +
            scenes.map((s, i) => `[a${i}]`).join("") +
            `concat=n=${scenes.length}:v=0:a=1[audio]`,
          "-map",
          "[audio]",
        ]
      : [];
    await run(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-threads",
        "1",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        join(dir, "source.mp4"),
        "-map",
        "0:v:0",
        ...audio,
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-t",
        String(duration),
        "-movflags",
        "+faststart",
        "-fs",
        "134217728",
        join(dir, "output.mp4"),
      ],
      remaining(),
    );
    const output = await probe(join(dir, "output.mp4"));
    if (Math.abs(output.duration - duration) > 0.15)
      throw failure("Bản xuất bị cắt do giới hạn tài nguyên");
    await checkQuota();
    onProgress(100);
  } finally {
    await Promise.all(temps.map((f) => unlink(f).catch(() => {})));
  }
}
