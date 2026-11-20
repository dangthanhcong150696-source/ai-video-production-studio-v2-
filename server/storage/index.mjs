// Workstream 1 — select a saved-project backend. Local is the default.
import { resolve } from "node:path";
import { failure } from "../limits.mjs";
import { createDriveBackend } from "./drive.mjs";
import { createLocalBackend } from "./local.mjs";

export async function createStorage(env = process.env, fetchImpl = globalThis.fetch) {
  const directory = resolve(env.SAVE_DIR || "saves-v3");
  const local = createLocalBackend(directory);
  await local.init();
  const drive = createDriveBackend(env, fetchImpl);
  const requested = env.STORAGE_BACKEND === "drive" ? "drive" : "local";
  return {
    local,
    drive,
    requested,
    backend(name = requested) {
      if (name === "local") return local;
      if (name === "drive") return drive;
      throw failure("Storage backend không hợp lệ");
    },
    async status() {
      return {
        active: requested,
        local: local.status(),
        drive: drive.status(),
      };
    },
  };
}
