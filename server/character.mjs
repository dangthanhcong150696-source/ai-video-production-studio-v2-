// Workstream 3 — character lock, rights, and the reusable prompt prefix.
import { failure } from "./limits.mjs";

export const RIGHTS_STATUSES = Object.freeze([
  "owned",
  "licensed",
  "internal-only",
  "unknown",
]);

export function rightsFlagged(status) {
  return status === "unknown" || status === "internal-only";
}

function text(value, label, max) {
  const clean = String(value ?? "").trim();
  if (clean.length > max) throw failure(`${label} tối đa ${max} ký tự`);
  return clean;
}

export function normalizeCharacter(input = {}) {
  const name = text(input.name, "Tên nhân vật", 120);
  if (!name) throw failure("Tên nhân vật là bắt buộc");
  const rightsStatus = input.rightsStatus;
  if (!RIGHTS_STATUSES.includes(rightsStatus))
    throw failure(
      "rightsStatus là bắt buộc: owned, licensed, internal-only hoặc unknown",
    );
  const attributes = input.lockedAttributes || input;
  return {
    name,
    rightsStatus,
    rightsNote: text(input.rightsNote, "Ghi chú quyền", 2000),
    rightsFlagged: rightsFlagged(rightsStatus),
    lockedAttributes: {
      face: text(attributes.face, "Khóa gương mặt", 500),
      hair: text(attributes.hair, "Khóa tóc", 500),
      outfit: text(attributes.outfit, "Khóa trang phục", 500),
      lighting: text(attributes.lighting, "Khóa ánh sáng", 500),
    },
    promptPrefix: text(input.promptPrefix, "Prompt prefix", 2000),
  };
}

export function effectivePrompt(prefix, body) {
  const locked = String(prefix || "").trim();
  const scene = String(body || "");
  if (!locked) return scene;
  if (scene.startsWith(locked)) return scene;
  return `${locked}\n\n${scene}`;
}

export function applyCharacterToProject(project, character) {
  project.characterLock = character;
  const prefix = character?.promptPrefix || "";
  for (const scene of project.scenes) {
    if (!scene.storyboard) continue;
    scene.storyboard.lockedPromptPrefix = prefix;
  }
  return project;
}
