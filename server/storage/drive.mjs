// Workstream 1 — Google Drive backend. Unconfigured unless env credentials exist.
// This module never reports a successful save without a Drive API response.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { failure } from "../limits.mjs";
import { safeJoin } from "./hash.mjs";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

function unconfigured(reason) {
  return Object.assign(new Error(reason), {
    status: 424,
    configured: false,
    backend: "drive",
  });
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function signServiceAccountJwt(account, now = Date.now()) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: DRIVE_SCOPE,
      aud: TOKEN_URL,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(account.private_key)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

export function driveConfig(env = process.env) {
  const folderId = (env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
  const inline = (env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || "").trim();
  const file = (env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE || "").trim();
  const oauth = {
    clientId: (env.GOOGLE_DRIVE_CLIENT_ID || "").trim(),
    clientSecret: (env.GOOGLE_DRIVE_CLIENT_SECRET || "").trim(),
    refreshToken: (env.GOOGLE_DRIVE_REFRESH_TOKEN || "").trim(),
  };
  const oauthComplete = !!(oauth.clientId && oauth.clientSecret && oauth.refreshToken);
  const oauthPartial =
    !oauthComplete && !!(oauth.clientId || oauth.clientSecret || oauth.refreshToken);
  let serviceAccount = null;
  let problem = "";
  if (inline || file) {
    try {
      const text = inline
        ? inline.startsWith("{")
          ? inline
          : Buffer.from(inline, "base64").toString("utf8")
        : readFileSync(file, "utf8");
      serviceAccount = JSON.parse(text);
      if (!serviceAccount.client_email || !serviceAccount.private_key)
        problem =
          "unconfigured: service account JSON is missing client_email or private_key";
    } catch (error) {
      problem = `unconfigured: service account JSON could not be read (${error.message})`;
    }
  }
  let reason = "";
  if (problem) reason = problem;
  else if (!folderId && !serviceAccount && !oauthComplete && !oauthPartial)
    reason =
      "unconfigured: set GOOGLE_DRIVE_FOLDER_ID and either a service-account JSON or an OAuth refresh token";
  else if (!folderId) reason = "unconfigured: GOOGLE_DRIVE_FOLDER_ID is not set";
  else if (oauthPartial)
    reason =
      "unconfigured: OAuth credentials are incomplete (client id, client secret, and refresh token are all required)";
  else if (!serviceAccount && !oauthComplete)
    reason =
      "unconfigured: Drive credentials are not set (service-account JSON or OAuth refresh token)";
  const configured = !reason && !!folderId && (!!serviceAccount || oauthComplete);
  return {
    configured,
    reason: configured ? "" : reason,
    folderId: configured ? folderId : "",
    auth: serviceAccount ? "service-account" : oauthComplete && configured ? "oauth-refresh" : "none",
    scope: DRIVE_SCOPE,
    serviceAccount: configured ? serviceAccount : null,
    oauth: configured && !serviceAccount ? oauth : null,
  };
}

function q(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function createDriveBackend(env = process.env, fetchImpl = globalThis.fetch) {
  const config = driveConfig(env);
  let cached = null;
  function assertReady() {
    if (!config.configured) throw unconfigured(config.reason);
  }
  async function accessToken() {
    assertReady();
    if (cached && cached.exp > Date.now() + 60_000) return cached.value;
    const body = config.serviceAccount
      ? new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signServiceAccountJwt(config.serviceAccount),
        })
      : new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.oauth.clientId,
          client_secret: config.oauth.clientSecret,
          refresh_token: config.oauth.refreshToken,
        });
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token)
      throw failure(
        `Google Drive từ chối cấp token (${response.status})`,
        502,
      );
    cached = {
      value: payload.access_token,
      exp: Date.now() + Number(payload.expires_in || 3600) * 1000,
    };
    return cached.value;
  }
  async function api(url, options = {}) {
    const token = await accessToken();
    const { raw, headers: extraHeaders, ...rest } = options;
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(extraHeaders || {}),
    };
    const response = await fetchImpl(url, { ...rest, headers });
    if (raw) return response;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || response.statusText || "Drive error";
      throw failure(`Google Drive lỗi: ${message}`, 502);
    }
    return payload;
  }
  async function listChildren(parentId, name) {
    const files = [];
    let pageToken = "";
    const filter = [
      `'${q(parentId)}' in parents`,
      "trashed = false",
      name ? `name = '${q(name)}'` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    do {
      const url = new URL(`${DRIVE_API}/files`);
      url.searchParams.set("q", filter);
      url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size)");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const payload = await api(url);
      files.push(...(payload.files || []));
      pageToken = payload.nextPageToken || "";
    } while (pageToken);
    return files;
  }
  async function createFolder(parentId, name) {
    return api(`${DRIVE_API}/files?supportsAllDrives=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    });
  }
  async function upload(parentId, name, filePath, mime) {
    const size = (await stat(filePath)).size;
    const startUrl = new URL(`${DRIVE_UPLOAD}/files`);
    startUrl.searchParams.set("uploadType", "resumable");
    startUrl.searchParams.set("supportsAllDrives", "true");
    const start = await api(startUrl, {
      method: "POST",
      raw: true,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime,
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify({ name, parents: [parentId], mimeType: mime }),
    });
    if (!start.ok) throw failure("Google Drive không mở phiên upload", 502);
    const location = start.headers.get("location");
    if (!location) throw failure("Google Drive không trả địa chỉ upload", 502);
    const bytes = await readFile(filePath);
    const put = await api(location, {
      method: "PUT",
      raw: true,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    });
    const payload = await put.json().catch(() => ({}));
    if (!put.ok || !payload.id)
      throw failure("Google Drive không nhận file", 502);
    return payload;
  }
  return {
    id: "drive",
    status() {
      return {
        backend: "drive",
        configured: config.configured,
        reason: config.reason,
        auth: config.auth,
        scope: DRIVE_SCOPE,
        folderId: config.folderId || null,
      };
    },
    async save(manifest, blobs) {
      assertReady();
      const id = manifest.project?.id;
      if (!/^[a-f0-9-]{36}$/.test(id || "")) throw failure("ID không hợp lệ");
      const existing = (await listChildren(config.folderId, id))[0];
      const staging = await createFolder(config.folderId, `${id}.staging`);
      const manifestPath = join(tmpdir(), `studio-manifest-${id}.json`);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      try {
        await upload(staging.id, "manifest.json", manifestPath, "application/json");
        for (const blob of blobs)
          await upload(staging.id, blob.path, blob.absPath, blob.mime || "application/octet-stream");
      } catch (error) {
        await api(`${DRIVE_API}/files/${staging.id}?supportsAllDrives=true`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trashed: true }),
        }).catch(() => {});
        throw error;
      }
      if (existing) {
        await api(`${DRIVE_API}/files/${existing.id}?supportsAllDrives=true`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trashed: true }),
        });
      }
      await api(`${DRIVE_API}/files/${staging.id}?supportsAllDrives=true`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: id }),
      });
      return { id, backend: "drive", folderId: staging.id };
    },
    async list() {
      assertReady();
      const folders = await listChildren(config.folderId);
      const projects = [];
      for (const folder of folders) {
        if (folder.mimeType !== "application/vnd.google-apps.folder") continue;
        if (!/^[a-f0-9-]{36}$/.test(folder.name)) continue;
        const manifestFile = (await listChildren(folder.id, "manifest.json"))[0];
        if (!manifestFile) {
          projects.push({ id: folder.name, backend: "drive", error: "missing manifest" });
          continue;
        }
        const response = await api(
          `${DRIVE_API}/files/${manifestFile.id}?alt=media&supportsAllDrives=true`,
          { raw: true },
        );
        if (!response.ok) {
          projects.push({ id: folder.name, backend: "drive", error: "manifest download failed" });
          continue;
        }
        try {
          const manifest = JSON.parse(await response.text());
          const project = manifest.project || {};
          projects.push({
            id: project.id || folder.name,
            name: project.name || folder.name,
            savedAt: manifest.savedAt || null,
            manifestVersion: manifest.manifestVersion,
            sceneCount: project.scenes?.length || 0,
            duration: project.duration ?? null,
            rightsFlagged: !!project.characterLock?.rightsFlagged,
            backend: "drive",
          });
        } catch (error) {
          projects.push({ id: folder.name, backend: "drive", error: error.message });
        }
      }
      return projects;
    },
    async load(id) {
      assertReady();
      if (!/^[a-f0-9-]{36}$/.test(id)) throw failure("ID không hợp lệ");
      const folder = (await listChildren(config.folderId, id))[0];
      if (!folder) throw failure("Không tìm thấy dự án trên Google Drive", 404);
      const files = await listChildren(folder.id);
      const directory = await mkdtemp(join(tmpdir(), "studio-drive-"));
      for (const file of files) {
        if (file.mimeType === "application/vnd.google-apps.folder") continue;
        const response = await api(
          `${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true`,
          { raw: true },
        );
        if (!response.ok)
          throw failure(`Không tải được ${file.name} từ Google Drive`, 502);
        const target = safeJoin(directory, file.name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(await response.arrayBuffer()));
      }
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      } catch {
        throw failure("Google Drive thiếu manifest.json", 502);
      }
      return { manifest, directory, temporary: true };
    },
  };
}
