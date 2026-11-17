import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import Timeline from "./Timeline";
type Scene = {
  id: number;
  start: number;
  duration: number;
  replacement: string | null;
  kind?: string;
  origin?: string;
};
type Project = {
  id: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  audio: boolean;
  scenes: Scene[];
};
type Job = { status: string; progress: number; error?: string };
async function api(path: string, options?: RequestInit) {
  const r = await fetch("/api" + path, options);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Yêu cầu thất bại");
  return data;
}
function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [job, setJob] = useState<Job>({ status: "idle", progress: 0 });
  const [selected, setSelected] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const [protectedUpload, setProtectedUpload] = useState(false);
  useEffect(() => {
    void api("/config")
      .then((c) => setProtectedUpload(c.authentication))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const id = localStorage.getItem("studio-v3-project");
    if (id)
      api(`/projects/${id}`)
        .then(setProject)
        .catch(() => localStorage.removeItem("studio-v3-project"));
  }, []);
  useEffect(() => {
    if (!project) return;
    let active = true;
    const poll = async () => {
      try {
        const j = await api(`/projects/${project.id}/export`);
        if (active) setJob(j);
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void poll();
    const t = setInterval(poll, 1000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [project?.id]);
  const [timelineDirty, setTimelineDirty] = useState(false);
  const locked = !!busy || job.status === "running";
  async function upload(file: File | undefined, scene?: number) {
    if (!file) return;
    setBusy(
      scene === undefined
        ? "Đang phân tích và chia cảnh…"
        : "Đang kiểm tra video thay thế…",
    );
    setError("");
    try {
      const body = new FormData();
      body.append("video", file);
      const p = await api(
        scene === undefined
          ? "/projects"
          : `/projects/${project!.id}/scenes/${scene}`,
        { method: "POST", body },
      );
      setProject(p);
      localStorage.setItem("studio-v3-project", p.id);
      setJob({ status: "idle", progress: 0 });
      if (scene === undefined) setSelected(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function exportVideo() {
    setError("");
    setBusy("Đang bắt đầu xuất…");
    try {
      setJob(await api(`/projects/${project!.id}/export`, { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function choose(s: Scene) {
    setSelected(s.id);
    if (video.current) {
      video.current.currentTime = s.start;
      void video.current.play().catch(() => {});
    }
  }
  return (
    <div className="app">
      <aside>
        <div className="logo">◈</div>
        <span className="nav active">⌘</span>
        <span className="nav">▤</span>
        <span className="side-label">
          LOCAL
          <br />
          STUDIO
        </span>
      </aside>
      <main>
        <header>
          <div>
            <span className="eyebrow">AI VIDEO PRODUCTION</span>
            <h1>
              Studio <em>V3</em>
            </h1>
          </div>
          <div className="top-right">
            <span className="badge">● Local engine</span>
            <span className="muted">0 API credits</span>
          </div>
        </header>
        <section className="toolbar">
          <div>
            <h2>Video production workflow</h2>
            <p>Nhập video, chỉnh từng cảnh và xuất thành phẩm.</p>
          </div>
          <label className={"button secondary " + (locked ? "disabled" : "")}>
            ＋ Nhập MP4
            <input
              type="file"
              accept="video/mp4,.mp4"
              disabled={locked}
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </section>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {busy && (
          <div role="status" className="notice">
            ◌ {busy}
          </div>
        )}
        <div className="notice">
          Render Free profile · 1 tác vụ · 50 MB/file · 120s · 5 dự án · dữ liệu
          hết hạn sau 6 giờ.{" "}
          {protectedUpload
            ? "Đã bật mật khẩu."
            : "Chưa bật mật khẩu; chỉ dùng media thử, không nhạy cảm."}
        </div>
        <section className="canvas">
          <div className="canvas-title">
            WORKFLOW CANVAS <span>01 / VIDEO PIPELINE</span>
          </div>
          <div className="pipeline">
            <article className="node">
              <div className="node-head">
                <span className="icon">↥</span>
                <span>01 · INPUT</span>
                <span className="dot" />
              </div>
              <h3>Video nguồn</h3>
              <p>MP4 · tối đa 50 MB / 120 giây</p>
              {project ? (
                <>
                  <video
                    ref={video}
                    controls
                    src={`/api/projects/${project.id}/source`}
                  />
                  <strong className="filename">{project.name}</strong>
                  <div className="stats">
                    {project.width} × {project.height}{" "}
                    <span>{project.duration.toFixed(2)}s</span>
                  </div>
                </>
              ) : (
                <label className="drop">
                  {" "}
                  <b>＋</b>Chọn video MP4 để bắt đầu
                  <input
                    type="file"
                    accept="video/mp4,.mp4"
                    disabled={locked}
                    onChange={(e) => void upload(e.target.files?.[0])}
                  />
                </label>
              )}
            </article>
            <div className="wire">→</div>
            <article className="node">
              <div className="node-head">
                <span className="icon purple">✂</span>
                <span>02 · SCENE SPLITTER</span>
                <span className="dot" />
              </div>
              <h3>Tự động chia cảnh</h3>
              <p>Phát hiện chuyển cảnh · mỗi đoạn ≤ 8 giây</p>
              <div className="metric">
                {project?.scenes.length ?? "—"}
                <small>CẢNH ĐƯỢC TẠO</small>
              </div>
              <div className="rule">
                <span>Độ dài tối đa</span>
                <b>8.00s</b>
              </div>
              <div className="rule">
                <span>Âm thanh gốc</span>
                <b>
                  {project
                    ? project.audio
                      ? "Giữ nguyên"
                      : "Không có"
                    : "Tự động"}
                </b>
              </div>
              <div className="hint">
                Thay hình từng cảnh; tiếng gốc giữ đúng mốc thời gian.
              </div>
            </article>
            <div className="wire">→</div>
            <article className="node">
              <div className="node-head">
                <span className="icon green">▶</span>
                <span>03 · RENDER OUTPUT</span>
                <span className="dot" />
              </div>
              <h3>Chuẩn hóa & ghép</h3>
              <p>FFmpeg · H.264 / AAC · 30 fps</p>
              <div className="output-symbol">
                ▣<span>MP4</span>
              </div>
              <div className="rule">
                <span>Khung hình</span>
                <b>Theo nguồn · ≤ 1280px rộng</b>
              </div>
              <button
                disabled={!project || locked || timelineDirty}
                onClick={() => void exportVideo()}
              >
                ▶ Xuất video
              </button>
              {job.status === "running" && (
                <div role="status">
                  <progress value={job.progress} max={100} />
                  <small>Đang xuất {job.progress}%</small>
                </div>
              )}
              {job.status === "failed" && (
                <div className="error">{job.error}</div>
              )}
              {job.status === "done" && (
                <a
                  className="download"
                  href={`/api/projects/${project?.id}/download`}
                >
                  ↓ Tải MP4 hoàn thành
                </a>
              )}
            </article>
          </div>
        </section>
        {project && (
          <Timeline
            project={project}
            locked={locked}
            onError={setError}
            onDirtyChange={setTimelineDirty}
            onUpdate={async () => {
              setProject(await api(`/projects/${project.id}`));
              setJob({ status: "idle", progress: 0 });
            }}
          />
        )}
        <section className="scenes">
          <div className="section-title">
            <div>
              <h2>
                Scene workspace <span>{project?.scenes.length ?? 0}</span>
              </h2>
              <p>
                Chọn cảnh để xem nguồn. Ảnh được giữ đủ thời lượng; video ngắn
                được lặp, dài được cắt.
              </p>
            </div>
            <span className="badge">ORIGINAL AUDIO PRESERVED</span>
          </div>
          {project ? (
            <div className="scene-grid">
              {project.scenes.map((s) => (
                <article
                  key={s.id}
                  className={"scene " + (selected === s.id ? "selected" : "")}
                >
                  <button className="scene-preview" onClick={() => choose(s)}>
                    <span>▶</span>
                    <b>SCENE {String(s.id + 1).padStart(2, "0")}</b>
                    <small>
                      {s.start.toFixed(2)}s →{" "}
                      {(s.start + s.duration).toFixed(2)}s
                    </small>
                  </button>
                  {s.replacement &&
                    (s.kind === "image" ? (
                      <img
                        className="scene-image"
                        alt={`Ảnh cảnh ${s.id + 1}`}
                        src={`/api/projects/${project.id}/scenes/${s.id}/preview?v=${s.replacement}`}
                      />
                    ) : (
                      <video
                        controls
                        src={`/api/projects/${project.id}/scenes/${s.id}/preview?v=${s.replacement}`}
                      />
                    ))}
                  <div className="scene-meta">
                    <b>{s.duration.toFixed(2)}s</b>
                    <span className={s.replacement ? "replaced" : ""}>
                      {s.replacement ? "● Đã thay media" : "Nguồn gốc"}
                    </span>
                  </div>
                  <label className={"replace " + (locked ? "disabled" : "")}>
                    ↻ Thay media
                    <input
                      type="file"
                      accept="video/mp4,image/png,image/jpeg"
                      disabled={locked}
                      onChange={(e) => {
                        void upload(e.target.files?.[0], s.id);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty">
              Các cảnh sẽ xuất hiện tại đây sau khi nhập video.
            </div>
          )}
        </section>
        {project && (
          <button
            disabled={locked}
            className="secondary"
            onClick={async () => {
              if (!window.confirm("Xóa toàn bộ media dự án hiện tại?")) return;
              try {
                await api(`/projects/${project.id}`, { method: "DELETE" });
                setProject(null);
                localStorage.removeItem("studio-v3-project");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Xóa dự án và giải phóng dung lượng
          </button>
        )}
        <footer>
          LOCAL PROCESSING · NO PAID API{" "}
          <span>AI VIDEO PRODUCTION STUDIO V3</span>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
