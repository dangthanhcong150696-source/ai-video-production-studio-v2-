import { useEffect, useState } from "react";
type Scene = {
  id: number;
  start: number;
  duration: number;
  replacement: string | null;
  kind?: string;
  origin?: string;
};
type Project = { id: string; duration: number; scenes: Scene[] };
type Props = {
  project: Project;
  locked: boolean;
  onUpdate: () => Promise<void>;
  onError: (text: string) => void;
  onDirtyChange: (dirty: boolean) => void;
};
async function request(path: string, options: RequestInit) {
  const r = await fetch("/api" + path, options);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
export default function Timeline({
  project,
  locked,
  onUpdate,
  onError,
  onDirtyChange,
}: Props) {
  const [draft, setDraft] = useState(project.scenes),
    [active, setActive] = useState(project.scenes[0]?.id),
    [mode, setMode] = useState("MOCK"),
    [kind, setKind] = useState("image"),
    [prompt, setPrompt] = useState("Studio concept"),
    [working, setWorking] = useState(false);
  useEffect(() => {
    setDraft(project.scenes);
    setActive((id) =>
      project.scenes.some((s) => s.id === id) ? id : project.scenes[0]?.id,
    );
  }, [project]);
  const scene = draft.find((s) => s.id === active);
  const total = draft.reduce((sum, s) => sum + s.duration, 0),
    disabled = locked || working,
    dirty = JSON.stringify(draft) !== JSON.stringify(project.scenes);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  async function action(fn: () => Promise<unknown>) {
    setWorking(true);
    onError("");
    try {
      await fn();
      await onUpdate();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  function saveDraft() {
    return request(`/projects/${project.id}/timeline`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenes: draft.map(({ id, start, duration }) => ({
          id,
          start,
          duration,
        })),
      }),
    });
  }
  function move(index: number, offset: number) {
    const next = [...draft];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    setDraft(next);
  }
  function patch(key: "start" | "duration", value: number) {
    setDraft(draft.map((s) => (s.id === active ? { ...s, [key]: value } : s)));
  }
  let elapsed = 0;
  return (
    <section className="timeline">
      <div className="section-title">
        <div>
          <h2>
            Scene Timeline <span>V3</span>
          </h2>
          <p>
            Sắp xếp, trim và ghép lại tiếng gốc theo thứ tự cảnh. Lưu timeline
            trước khi xuất.
          </p>
        </div>
        <b>{total.toFixed(2)}s / 120s</b>
      </div>
      <div className="timeline-track" aria-label="Timeline">
        {draft.map((s, index) => {
          const start = elapsed;
          elapsed += s.duration;
          return (
            <button
              disabled={disabled}
              key={s.id}
              onClick={() => setActive(s.id)}
              className={active === s.id ? "clip current" : "clip"}
              style={{ flexGrow: Math.max(0.1, s.duration) }}
            >
              <strong>
                {index + 1} · Cảnh {s.id + 1}
              </strong>
              <small>
                {start.toFixed(2)}–{elapsed.toFixed(2)}s
              </small>
              <span>
                {s.origin || "source"} · {s.duration.toFixed(2)}s
              </span>
            </button>
          );
        })}
      </div>
      <div className="timeline-controls">
        {draft.map((s, index) => (
          <div key={s.id}>
            <span>Cảnh {s.id + 1}</span>
            <button
              aria-label={`Di chuyển cảnh ${s.id + 1} sang trái`}
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
            >
              ←
            </button>
            <button
              aria-label={`Di chuyển cảnh ${s.id + 1} sang phải`}
              disabled={disabled || index === draft.length - 1}
              onClick={() => move(index, 1)}
            >
              →
            </button>
            <button
              aria-label={`Xóa cảnh ${s.id + 1}`}
              disabled={disabled || draft.length === 1}
              onClick={() => setDraft(draft.filter((x) => x.id !== s.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {scene && (
        <div className="inspector">
          <div>
            <h3>Cảnh {scene.id + 1} · Trim nguồn & âm thanh</h3>
            <label>
              Bắt đầu nguồn (s)
              <input
                aria-label="Bắt đầu nguồn"
                type="number"
                min="0"
                max={project.duration}
                step="0.1"
                disabled={disabled}
                value={scene.start}
                onChange={(e) => patch("start", Number(e.target.value))}
              />
            </label>
            <label>
              Thời lượng (s)
              <input
                aria-label="Thời lượng cảnh"
                type="number"
                min="0.1"
                max="8"
                step="0.1"
                disabled={disabled}
                value={scene.duration}
                onChange={(e) => patch("duration", Number(e.target.value))}
              />
            </label>
            <div className="actions">
              <button
                disabled={disabled || !dirty}
                onClick={() => void action(saveDraft)}
              >
                Lưu timeline
              </button>
              <button
                className="secondary"
                disabled={disabled || !dirty}
                onClick={() => setDraft(project.scenes)}
              >
                Bỏ thay đổi
              </button>
            </div>
          </div>
          <div>
            <h3>Image / Video Provider Adapter</h3>
            <label>
              Chế độ
              <select
                aria-label="Provider mode"
                value={mode}
                disabled={disabled}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="MOCK">MOCK · tạo mẫu cục bộ</option>
                <option value="LIVE">LIVE · nhập Google Flow thủ công</option>
              </select>
            </label>
            {mode === "MOCK" ? (
              <>
                <label>
                  Media
                  <select
                    aria-label="Media kind"
                    value={kind}
                    disabled={disabled}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option value="image">Ảnh PNG</option>
                    <option value="video">Video MP4</option>
                  </select>
                </label>
                <label>
                  Prompt mẫu
                  <input
                    aria-label="Mock prompt"
                    maxLength={1000}
                    value={prompt}
                    disabled={disabled}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </label>
                <button
                  disabled={disabled || dirty}
                  onClick={() =>
                    void action(() =>
                      request(
                        `/projects/${project.id}/scenes/${scene.id}/generate`,
                        {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ mode, kind, prompt }),
                        },
                      ),
                    )
                  }
                >
                  Tạo {kind === "image" ? "ảnh" : "video"} MOCK
                </button>
                <p>
                  Mẫu màu xác định theo prompt, không phải AI tạo sinh. Không
                  gọi mạng.
                </p>
              </>
            ) : (
              <>
                <p>
                  Tải PNG/JPEG/MP4 từ Google Flow về máy rồi chọn file ở đây.
                  Không kết nối tài khoản, tự động hóa Flow hoặc gọi API.
                </p>
                <label
                  className={
                    "button secondary " + (disabled || dirty ? "disabled" : "")
                  }
                >
                  Nhập media từ Google Flow
                  <input
                    aria-label="Nhập Google Flow"
                    type="file"
                    accept="video/mp4,image/png,image/jpeg"
                    disabled={disabled || dirty}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f)
                        void action(() => {
                          const body = new FormData();
                          body.append("video", f);
                          body.append("origin", "google-flow");
                          return request(
                            `/projects/${project.id}/scenes/${scene.id}`,
                            { method: "POST", body },
                          );
                        });
                      e.target.value = "";
                    }}
                  />
                </label>
                <p>
                  LIVE generation: chưa hỗ trợ; mọi yêu cầu sinh qua API đều bị
                  chặn.
                </p>
              </>
            )}
          </div>
          <div>
            <h3>Media đang dùng</h3>
            {scene.replacement ? (
              scene.kind === "image" ? (
                <img
                  alt={`Ảnh cảnh ${scene.id + 1}`}
                  src={`/api/projects/${project.id}/scenes/${scene.id}/preview?v=${scene.replacement}`}
                />
              ) : (
                <video
                  controls
                  src={`/api/projects/${project.id}/scenes/${scene.id}/preview?v=${scene.replacement}`}
                />
              )
            ) : (
              <p>Video nguồn · {scene.start.toFixed(2)}s</p>
            )}
            <p>Nguồn: {scene.origin || "source"}</p>
          </div>
        </div>
      )}
      {dirty && (
        <div className="notice">
          Có thay đổi chưa lưu. Thứ tự bản xuất chỉ đổi sau khi bấm Lưu
          timeline.
        </div>
      )}
      {working && <div role="status">Đang xử lý media/timeline…</div>}
    </section>
  );
}
