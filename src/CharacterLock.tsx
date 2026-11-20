import { useState } from "react";
export type CharacterRecord = {
  id: string;
  name: string;
  rightsStatus: "owned" | "licensed" | "internal-only" | "unknown";
  rightsNote: string;
  rightsFlagged: boolean;
  lockedAttributes: {
    face: string;
    hair: string;
    outfit: string;
    lighting: string;
  };
  promptPrefix: string;
  referenceImages: { filename: string; sha256: string }[];
};
type Props = {
  projectId?: string;
  attached?: CharacterRecord | null;
  locked: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
};
async function request(path: string, options: RequestInit) {
  const response = await fetch("/api" + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Không lưu được nhân vật");
  return data;
}
const statuses = ["owned", "licensed", "internal-only", "unknown"] as const;
export default function CharacterLock({
  projectId,
  attached,
  locked,
  onChanged,
  onError,
}: Props) {
  const [name, setName] = useState("");
  const [rightsStatus, setRightsStatus] =
    useState<(typeof statuses)[number]>("unknown");
  const [rightsNote, setRightsNote] = useState("");
  const [face, setFace] = useState("");
  const [hair, setHair] = useState("");
  const [outfit, setOutfit] = useState("");
  const [lighting, setLighting] = useState("");
  const [promptPrefix, setPromptPrefix] = useState("");
  const [file, setFile] = useState<File | undefined>();
  const [created, setCreated] = useState<CharacterRecord | null>(null);
  const [working, setWorking] = useState(false);
  const shown = attached || created;
  const flagged = shown?.rightsFlagged;
  async function create() {
    setWorking(true);
    onError("");
    try {
      const body = new FormData();
      body.append("name", name);
      body.append("rightsStatus", rightsStatus);
      body.append("rightsNote", rightsNote);
      body.append("face", face);
      body.append("hair", hair);
      body.append("outfit", outfit);
      body.append("lighting", lighting);
      body.append("promptPrefix", promptPrefix);
      if (file) body.append("reference", file);
      const record = await request("/characters", { method: "POST", body });
      setCreated(record);
      setFile(undefined);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function attach(characterId: string) {
    if (!projectId) return;
    setWorking(true);
    onError("");
    try {
      await request(`/projects/${projectId}/character`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId }),
      });
      await onChanged();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="character-lock">
      <div className="section-title">
        <div>
          <h2>
            Character Lock <span>V3.2</span>
          </h2>
          <p>
            Ghi nhận nhân vật, quyền sử dụng và prefix prompt dùng lại cho từng
            cảnh. Không gọi AI.
          </p>
        </div>
      </div>
      {shown?.rightsFlagged && (
        <div role="status" className="flag">
          Rights {shown.rightsStatus}: flagged. Unknown và internal-only không
          được xem là đã được phép dùng bên ngoài.
        </div>
      )}
      {attached && (
        <div className="character-card">
          <strong>{attached.name}</strong>
          <span className={attached.rightsFlagged ? "flag-inline" : "rights-ok"}>
            rightsStatus: {attached.rightsStatus}
            {attached.rightsFlagged ? " · flagged" : ""}
          </span>
          <p>
            {attached.lockedAttributes.face || "—"} ·{" "}
            {attached.lockedAttributes.hair || "—"} ·{" "}
            {attached.lockedAttributes.outfit || "—"} ·{" "}
            {attached.lockedAttributes.lighting || "—"}
          </p>
          {attached.promptPrefix && (
            <pre className="prefix">{attached.promptPrefix}</pre>
          )}
          {attached.referenceImages[0] && (
            <img
              alt={`Ảnh tham chiếu ${attached.name}`}
              src={`/api/characters/${attached.id}/references/0?v=${attached.referenceImages[0].sha256.slice(0, 8)}`}
            />
          )}
        </div>
      )}
      <div className="character-form">
        <label>
          Tên nhân vật
          <input
            aria-label="Tên nhân vật"
            value={name}
            disabled={locked || working}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          rightsStatus
          <select
            aria-label="rightsStatus"
            value={rightsStatus}
            disabled={locked || working}
            onChange={(event) =>
              setRightsStatus(event.target.value as (typeof statuses)[number])
            }
          >
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ghi chú quyền
          <input
            aria-label="Ghi chú quyền"
            value={rightsNote}
            disabled={locked || working}
            onChange={(event) => setRightsNote(event.target.value)}
          />
        </label>
        <label>
          Khóa gương mặt
          <input
            aria-label="Khóa gương mặt"
            value={face}
            disabled={locked || working}
            onChange={(event) => setFace(event.target.value)}
          />
        </label>
        <label>
          Khóa tóc
          <input
            aria-label="Khóa tóc"
            value={hair}
            disabled={locked || working}
            onChange={(event) => setHair(event.target.value)}
          />
        </label>
        <label>
          Khóa trang phục
          <input
            aria-label="Khóa trang phục"
            value={outfit}
            disabled={locked || working}
            onChange={(event) => setOutfit(event.target.value)}
          />
        </label>
        <label>
          Khóa ánh sáng
          <input
            aria-label="Khóa ánh sáng"
            value={lighting}
            disabled={locked || working}
            onChange={(event) => setLighting(event.target.value)}
          />
        </label>
        <label>
          Prompt prefix khóa
          <textarea
            aria-label="Prompt prefix khóa"
            rows={3}
            value={promptPrefix}
            disabled={locked || working}
            onChange={(event) => setPromptPrefix(event.target.value)}
          />
        </label>
        <label className={"button secondary " + (locked || working ? "disabled" : "")}>
          Ảnh tham chiếu
          <input
            aria-label="Ảnh tham chiếu nhân vật"
            type="file"
            accept="image/png,image/jpeg"
            disabled={locked || working}
            onChange={(event) => setFile(event.target.files?.[0])}
          />
        </label>
        <button disabled={locked || working || !name} onClick={() => void create()}>
          Tạo nhân vật
        </button>
        {created && projectId && (
          <button
            className="secondary"
            disabled={locked || working}
            onClick={() => void attach(created.id)}
          >
            Gắn vào dự án
          </button>
        )}
        {flagged && created && !attached && (
          <div role="status" className="flag">
            Bản ghi vừa tạo có rightsStatus {created.rightsStatus} và được đánh
            dấu flagged.
          </div>
        )}
      </div>
    </section>
  );
}
