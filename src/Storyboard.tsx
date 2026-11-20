import { useEffect, useState } from "react";
import { applySkillRecipe, SKILL_RECIPES, type SkillName } from "./skillEngine";
type Asset = { file: string; provider: string; originalName: string };
type Board = {
  referenceKey: string;
  prompts: { image: string; motion: string };
  lockedPromptPrefix?: string;
  image?: Asset;
  video?: Asset;
  needsReview?: boolean;
};
type Scene = {
  id: number;
  start: number;
  duration: number;
  storyboard?: Board;
};
type Props = {
  project: {
    id: string;
    scenes: Scene[];
    characterLock?: { promptPrefix?: string; rightsFlagged?: boolean; rightsStatus?: string } | null;
  };
  locked: boolean;
  onUpdate: () => Promise<void>;
  onError: (message: string) => void;
  onBusy: (message: string) => void;
};
function withPrefix(prefix: string, body: string) {
  const locked = prefix.trim();
  if (!locked || body.startsWith(locked)) return body;
  return `${locked}\n\n${body}`;
}
async function request(path: string, options: RequestInit) {
  const r = await fetch("/api" + path, options),
    p = await r.json();
  if (!r.ok) throw new Error(p.error || "Không thể cập nhật Storyboard");
  return p;
}
function Card({
  scene,
  index,
  projectId,
  locked,
  action,
  prefix,
}: {
  scene: Scene;
  index: number;
  projectId: string;
  locked: boolean;
  action: (fn: () => Promise<unknown>) => Promise<void>;
  prefix: string;
}) {
  const board = scene.storyboard;
  const [image, setImage] = useState(board?.prompts.image || ""),
    [motion, setMotion] = useState(board?.prompts.motion || ""),
    [provider, setProvider] = useState("Omni Flash"),
    [selectedSkill, setSelectedSkill] = useState<SkillName>("continuity");
  useEffect(() => {
    setImage(board?.prompts.image || "");
    setMotion(board?.prompts.motion || "");
  }, [board?.prompts.image, board?.prompts.motion]);
  if (!board)
    return (
      <article className="story-card">
        Cảnh {scene.id + 1}: cần khởi tạo Storyboard.
      </article>
    );
  const root = `/projects/${projectId}/storyboard/${scene.id}`;
  async function upload(file: File | undefined, kind: string) {
    if (!file) return;
    await action(() => {
      const body = new FormData();
      body.append("video", file);
      body.append("provider", provider);
      return request(`${root}/import/${kind}`, { method: "POST", body });
    });
  }
  const dirty =
    image !== board.prompts.image || motion !== board.prompts.motion;
  return (
    <article className="story-card" data-scene-id={scene.id}>
      <header>
        <h3>
          Shot {index + 1} · Cảnh {scene.id + 1}
        </h3>
        <span>{scene.duration.toFixed(2)}s</span>
      </header>
      <p>
        Nguồn {scene.start.toFixed(2)}–
        {(scene.start + scene.duration).toFixed(2)}s ·{" "}
        {board.video
          ? "Clip sẵn sàng"
          : board.image
            ? "Có ảnh, chờ clip"
            : "Chờ media mới"}
      </p>
      {board.needsReview && (
        <div className="notice">
          Trim đã thay đổi: kiểm tra lại media và prompt trước khi xuất.
        </div>
      )}
      <div className="reference-pair">
        {(["start", "end"] as const).map((edge) => (
          <a
            key={edge}
            href={`/api${root}/references/${edge}?v=${board.referenceKey}`}
            download={`scene-${scene.id + 1}-${edge}.jpg`}
          >
            <img
              alt={`Cảnh ${scene.id + 1} ${edge === "start" ? "đầu" : "cuối"}`}
              src={`/api${root}/references/${edge}?v=${board.referenceKey}`}
            />
            <span>↓ Ảnh {edge === "start" ? "đầu" : "cuối"}</span>
          </a>
        ))}
      </div>
      {prefix && (
        <pre className="prefix" aria-label={`Prefix khóa cảnh ${scene.id + 1}`}>
          {prefix}
        </pre>
      )}
      <label>
        Prompt ảnh · Nano Banana Pro
        <textarea
          aria-label={`Prompt ảnh cảnh ${scene.id + 1}`}
          maxLength={4000}
          rows={4}
          disabled={locked}
          value={image}
          onChange={(e) => setImage(e.target.value)}
        />
      </label>
      <label>
        Prompt chuyển động · Omni Flash / Plus
        <textarea
          aria-label={`Prompt chuyển động cảnh ${scene.id + 1}`}
          maxLength={4000}
          rows={4}
          disabled={locked}
          value={motion}
          onChange={(e) => setMotion(e.target.value)}
        />
      </label>
      <div className="notice">
        <strong>Skill Engine · chuẩn bị prompt offline</strong>
        <p>Áp dụng quy tắc vào bản nháp, không gọi AI, không tiêu credits. Kiểm tra rồi bấm Lưu prompt.</p>
        <div className="actions">
          <select
            aria-label={`Skill cho cảnh ${scene.id + 1}`}
            disabled={locked}
            value={selectedSkill}
            onChange={(e) => setSelectedSkill(e.target.value as SkillName)}
          >
            {SKILL_RECIPES.map((skill) => (
              <option key={skill.id} value={skill.id}>{skill.label}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              try {
                const result = applySkillRecipe(scene, {image, motion}, selectedSkill);
                setImage(result.image);
                setMotion(result.motion);
              } catch (e) { window.alert((e as Error).message); }
            }}
          >Áp dụng Skill vào prompt</button>
        </div>
      </div>
      <div className="actions">
        <button
          disabled={locked || !dirty}
          onClick={() =>
            void action(() =>
              request(`${root}/prompts`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image, motion }),
              }),
            )
          }
        >
          Lưu prompt cảnh {scene.id + 1}
        </button>
        <a
          className="button secondary"
          download={`scene-${scene.id + 1}-prompts.txt`}
          href={
            "data:text/plain;charset=utf-8," +
            encodeURIComponent(
              `IMAGE\n${withPrefix(prefix, image)}\n\nMOTION\n${withPrefix(prefix, motion)}`,
            )
          }
        >
          ↓ Tải prompt
        </a>
      </div>
      <div className="story-imports">
        <div>
          <h4>1 · Ảnh Nano Banana Pro</h4>
          <p>
            Tự tạo ảnh bằng công cụ bạn có quyền dùng, tải về rồi nhập vào đây.
          </p>
          <label className={"button secondary " + (locked ? "disabled" : "")}>
            Nhập ảnh cho cảnh {scene.id + 1}
            <input
              aria-label={`Ảnh Nano Banana cảnh ${scene.id + 1}`}
              type="file"
              accept="image/png,image/jpeg"
              disabled={locked}
              onChange={(e) => {
                void upload(e.target.files?.[0], "image");
                e.target.value = "";
              }}
            />
          </label>
          {board.image && (
            <>
              <img
                className="asset-preview"
                alt={`Ảnh Nano đã nhập cảnh ${scene.id + 1}`}
                src={`/api${root}/media/image?v=${board.image.file}`}
              />
              <small>{board.image.originalName}</small>
            </>
          )}
        </div>
        <div>
          <h4>2 · Clip Omni Flash / Plus</h4>
          <label>
            Công cụ đã dùng
            <select
              aria-label={`Omni provider cảnh ${scene.id + 1}`}
              disabled={locked}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option>Omni Flash</option>
              <option>Omni Plus</option>
            </select>
          </label>
          <label className={"button secondary " + (locked ? "disabled" : "")}>
            Nhập clip cho cảnh {scene.id + 1}
            <input
              aria-label={`Clip Omni cảnh ${scene.id + 1}`}
              type="file"
              accept="video/mp4"
              disabled={locked}
              onChange={(e) => {
                void upload(e.target.files?.[0], "video");
                e.target.value = "";
              }}
            />
          </label>
          {board.video && (
            <>
              <video
                className="asset-preview"
                controls
                src={`/api${root}/media/video?v=${board.video.file}`}
              />
              <small>
                {board.video.provider} · {board.video.originalName}
              </small>
            </>
          )}
        </div>
      </div>
      <p className="story-foot">
        File gắn cố định với ID cảnh {scene.id + 1}, kể cả khi đổi thứ tự. Clip
        nhập sẽ cập nhật Timeline; ảnh được giữ riêng. Tiếng vẫn lấy từ MP4 mẫu.
      </p>
    </article>
  );
}
export default function Storyboard({
  project,
  locked,
  onUpdate,
  onError,
  onBusy,
}: Props) {
  const [working, setWorking] = useState(false);
  async function action(fn: () => Promise<unknown>) {
    setWorking(true);
    onBusy("Đang cập nhật Storyboard…");
    onError("");
    try {
      await fn();
      await onUpdate();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setWorking(false);
      onBusy("");
    }
  }
  return (
    <section className="storyboard">
      <div className="section-title">
        <div>
          <h2>Storyboard · MP4 → ảnh → clip → MP4</h2>
          <p>
            Prompt mẫu theo cảnh và ảnh tham chiếu; chưa dùng AI phân tích nội
            dung. LIVE API khóa · 0 credits.
          </p>
        </div>
        {project.scenes.some((s) => !s.storyboard) && (
          <button
            disabled={locked || working}
            onClick={() =>
              void action(() =>
                request(`/projects/${project.id}/storyboard`, {
                  method: "POST",
                }),
              )
            }
          >
            Khởi tạo Storyboard
          </button>
        )}
      </div>
      <p>
        Nano Banana Pro / Omni Flash / Plus là nhãn công cụ nhập thủ công do
        người dùng chọn; chưa xác minh API hoặc khả năng truy cập qua Google
        Flow. Ứng dụng không mở Flow, gửi prompt hay tự tạo media AI.
      </p>
      {project.characterLock?.rightsFlagged && (
        <div role="status" className="flag">
          Character lock rightsStatus {project.characterLock.rightsStatus}: flagged
          trong manifest và giao diện.
        </div>
      )}
      <div className="story-grid">
        {project.scenes.map((s, i) => (
          <Card
            key={s.id}
            scene={s}
            index={i}
            projectId={project.id}
            locked={locked || working}
            action={action}
            prefix={project.characterLock?.promptPrefix || s.storyboard?.lockedPromptPrefix || ""}
          />
        ))}
      </div>
    </section>
  );
}
