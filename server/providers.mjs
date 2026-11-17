import { run } from "./media.mjs";
import { failure } from "./limits.mjs";

// Both image and video providers implement the same local interface.
// No adapter in this registry has HTTP or billing capabilities.
const mockAdapter = {
  async generate({ kind, prompt }, output) {
    let hash = 0;
    for (const c of prompt) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    const color = hash.toString(16).padStart(6, "0").slice(-6);
    const args = [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x${color}:s=640x360:r=30:d=2`,
      "-threads",
      "1",
    ];
    await run(
      "ffmpeg",
      kind === "image"
        ? [...args, "-frames:v", "1", output]
        : [...args, "-c:v", "libx264", "-pix_fmt", "yuv420p", output],
    );
    return { mode: "MOCK", kind, prompt, origin: "mock", networkCalls: 0 };
  },
};
const liveAdapter = {
  async generate() {
    throw failure(
      "LIVE chỉ nhận file tải thủ công từ Google Flow. API sinh media chưa được bật; không gửi yêu cầu hoặc tiêu credits.",
      501,
    );
  },
  importMedia({ kind, origin }) {
    if (!["image", "video"].includes(kind)) throw failure("Media không hợp lệ");
    return {
      kind,
      origin: origin === "google-flow" ? "google-flow" : "manual",
      mode: "LIVE",
      prompt: "",
      networkCalls: 0,
    };
  },
};
export const providerAdapters = Object.freeze({
  MOCK: mockAdapter,
  LIVE: liveAdapter,
});
export const providers = [
  {
    id: "MOCK",
    name: "Local FFmpeg mock",
    image: true,
    video: true,
    generation: true,
    network: false,
  },
  {
    id: "LIVE",
    name: "Google Flow · nhập thủ công",
    image: true,
    video: true,
    generation: false,
    network: false,
  },
];
export async function generateMedia({ mode, kind, prompt }, output) {
  const adapter = providerAdapters[mode];
  if (!adapter || !["image", "video"].includes(kind))
    throw failure("Provider hoặc loại media không hợp lệ");
  if (typeof prompt !== "string" || prompt.length > 1000)
    throw failure("Prompt tối đa 1000 ký tự");
  return adapter.generate({ kind, prompt }, output);
}
export function importMedia(input) {
  return liveAdapter.importMedia(input);
}
