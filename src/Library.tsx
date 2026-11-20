type LiveProject = {
  id: string;
  name: string;
  sceneCount: number;
  persisted?: boolean;
  duration?: number;
  rightsFlagged?: boolean;
};
type SavedProject = {
  id: string;
  name?: string;
  savedAt?: string | null;
  sceneCount?: number;
  error?: string;
  rightsFlagged?: boolean;
  backend?: string;
};
type StorageStatus = {
  active: string;
  local?: { configured: boolean; directory?: string };
  drive?: { configured: boolean; reason?: string; scope?: string; auth?: string };
};
type Props = {
  live: LiveProject[];
  saved: SavedProject[];
  storage?: StorageStatus | null;
  projectId?: string;
  locked: boolean;
  onOpen: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
};
async function request(path: string, options?: RequestInit) {
  const response = await fetch("/api" + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Yêu cầu lưu trữ thất bại");
  return data;
}
export default function Library({
  live,
  saved,
  storage,
  projectId,
  locked,
  onOpen,
  onRefresh,
  onError,
}: Props) {
  const drive = storage?.drive;
  async function save(backend: string) {
    if (!projectId) return;
    onError("");
    try {
      await request(`/projects/${projectId}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend }),
      });
      await onRefresh();
    } catch (error) {
      onError((error as Error).message);
    }
  }
  async function restore(id: string, backend = "local") {
    onError("");
    try {
      const project = await request(`/saved/${id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend }),
      });
      await onOpen(project.id);
    } catch (error) {
      onError((error as Error).message);
    }
  }
  async function uploadBundle(file: File | undefined) {
    if (!file) return;
    onError("");
    try {
      const body = new FormData();
      body.append("bundle", file);
      const project = await request("/bundles", { method: "POST", body });
      await onOpen(project.id);
    } catch (error) {
      onError((error as Error).message);
    }
  }
  return (
    <section className="library">
      <div className="section-title">
        <div>
          <h2>
            Saved projects <span>V3.2</span>
          </h2>
          <p>
            Danh sách dự án nằm trên server. ID không chỉ sống trong
            localStorage. Bản đã lưu không bị xóa sau 6 giờ và khôi phục được
            sau khi đĩa tạm biến mất.
          </p>
        </div>
      </div>
      <div className="storage-status">
        <span>Local: {storage?.local?.configured ? "sẵn sàng" : "lỗi"}</span>
        <span>
          Google Drive:{" "}
          {drive?.configured
            ? `đã cấu hình (${drive.auth})`
            : `unconfigured${drive?.reason ? ` — ${drive.reason}` : ""}`}
        </span>
      </div>
      <div className="library-actions">
        <button disabled={!projectId || locked} onClick={() => void save("local")}>
          Lưu dự án
        </button>
        <button
          className="secondary"
          disabled={!projectId || locked}
          onClick={() => void save("drive")}
        >
          Lưu lên Drive
        </button>
        {projectId && (
          <a className="button secondary" href={`/api/projects/${projectId}/bundle`}>
            ↓ Tải bundle .zip
          </a>
        )}
        <label className={"button secondary " + (locked ? "disabled" : "")}>
          Khôi phục từ bundle
          <input
            aria-label="Tải bundle lên"
            type="file"
            accept=".zip,application/zip"
            disabled={locked}
            onChange={(event) => {
              void uploadBundle(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      <div className="project-columns">
        <div>
          <h3>Đang mở trên máy này</h3>
          {live.length ? (
            <ul className="project-list">
              {live.map((item) => (
                <li key={item.id}>
                  <button
                    className="secondary"
                    disabled={locked}
                    onClick={() => void onOpen(item.id)}
                  >
                    {item.name} · {item.sceneCount} cảnh
                    {item.persisted ? " · đã lưu" : ""}
                    {item.rightsFlagged ? " · rights flagged" : ""}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Chưa có dự án trên đĩa tạm.</p>
          )}
        </div>
        <div>
          <h3>Kho đã lưu</h3>
          {saved.length ? (
            <ul className="project-list">
              {saved.map((item) => (
                <li key={item.id}>
                  <button
                    className="secondary"
                    disabled={locked || !!item.error}
                    onClick={() => void restore(item.id, item.backend || "local")}
                  >
                    {item.error
                      ? `${item.id} · ${item.error}`
                      : `${item.name || item.id} · ${item.sceneCount ?? "?"} cảnh`}
                    {item.rightsFlagged ? " · rights flagged" : ""}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Chưa có bản lưu.</p>
          )}
        </div>
      </div>
    </section>
  );
}
