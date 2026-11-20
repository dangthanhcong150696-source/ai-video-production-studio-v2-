import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createVerify } from "node:crypto";
import { run } from "../server/media.mjs";
import {
  DRIVE_SCOPE,
  createDriveBackend,
  driveConfig,
  signServiceAccountJwt,
} from "../server/storage/drive.mjs";
import { extractBundle, readZip, writeZip } from "../server/storage/zip.mjs";
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rsaPem() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("Drive reports unconfigured and never fakes a save", async () => {
  const absent = driveConfig({});
  assert.equal(absent.configured, false);
  assert.match(absent.reason, /unconfigured/i);
  assert.equal(absent.auth, "none");
  const folderOnly = driveConfig({ GOOGLE_DRIVE_FOLDER_ID: "folder" });
  assert.equal(folderOnly.configured, false);
  assert.match(folderOnly.reason, /unconfigured/i);
  const partial = driveConfig({
    GOOGLE_DRIVE_FOLDER_ID: "folder",
    GOOGLE_DRIVE_CLIENT_ID: "id",
  });
  assert.equal(partial.configured, false);
  assert.match(partial.reason, /incomplete|unconfigured/i);
  const broken = driveConfig({
    GOOGLE_DRIVE_FOLDER_ID: "folder",
    GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: "{",
  });
  assert.equal(broken.configured, false);
  assert.match(broken.reason, /unconfigured/i);
  let calls = 0;
  const backend = createDriveBackend({}, async () => {
    calls += 1;
    throw new Error("network should not be used");
  });
  assert.equal(backend.status().configured, false);
  await assert.rejects(
    () => backend.save({ project: { id: randomUUID() } }, []),
    /unconfigured/i,
  );
  await assert.rejects(() => backend.list(), /unconfigured/i);
  assert.equal(calls, 0);
});

test("Drive client signs a service-account token and uploads only after Google accepts it", async () => {
  const { privateKey, publicKey } = rsaPem();
  const account = {
    client_email: "studio@example.iam.gserviceaccount.com",
    private_key: privateKey,
  };
  const json = JSON.stringify(account);
  const encoded = Buffer.from(json).toString("base64");
  for (const credentials of [
    { GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: json },
    { GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: encoded },
  ]) {
    const config = driveConfig({
      GOOGLE_DRIVE_FOLDER_ID: "folder-123",
      ...credentials,
    });
    assert.equal(config.configured, true);
    assert.equal(config.auth, "service-account");
    assert.equal(config.scope, DRIVE_SCOPE);
  }
  const oauth = driveConfig({
    GOOGLE_DRIVE_FOLDER_ID: "folder-123",
    GOOGLE_DRIVE_CLIENT_ID: "client",
    GOOGLE_DRIVE_CLIENT_SECRET: "secret",
    GOOGLE_DRIVE_REFRESH_TOKEN: "refresh",
  });
  assert.equal(oauth.configured, true);
  assert.equal(oauth.auth, "oauth-refresh");
  const assertion = signServiceAccountJwt(account, 1_700_000_000_000);
  const [header, payload, signature] = assertion.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.scope, DRIVE_SCOPE);
  assert.equal(claims.iss, account.client_email);
  assert.equal(
    createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, "base64url")),
    true,
  );
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || "GET", body: options.body });
    const ok = (data, extra = {}) => ({
      ok: true,
      status: 200,
      headers: { get: (name) => extra[name.toLowerCase()] || null },
      json: async () => data,
      text: async () => JSON.stringify(data),
      arrayBuffer: async () => Buffer.from(JSON.stringify(data)),
    });
    if (href === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(options.body);
      assert.equal(
        params.get("grant_type"),
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
      return ok({ access_token: "token-from-google", expires_in: 3600 });
    }
    if (href.includes("uploadType=resumable"))
      return ok({}, { location: "https://upload.example/session-1" });
    if (href.startsWith("https://upload.example/"))
      return ok({ id: "file-from-google", name: "manifest.json" });
    if (href.includes("/drive/v3/files?")) return ok({ files: [] });
    if (options.method === "POST")
      return ok({ id: "folder-from-google", name: "staging" });
    if (options.method === "PATCH") return ok({ id: "renamed" });
    return { ok: false, status: 404, json: async () => ({ error: { message: href } }) };
  };
  const work = await mkdtemp(join(tmpdir(), "studio-drive-"));
  const file = join(work, "blob.bin");
  await writeFile(file, "studio");
  const backend = createDriveBackend(
    {
      GOOGLE_DRIVE_FOLDER_ID: "folder-123",
      GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: json,
    },
    fetchImpl,
  );
  const id = randomUUID();
  const saved = await backend.save(
    { project: { id, name: "Drive protocol" } },
    [{ path: "media/note.txt", absPath: file, mime: "text/plain" }],
  );
  assert.equal(saved.backend, "drive");
  assert.equal(saved.id, id);
  assert.ok(calls.some((call) => call.href.includes("oauth2.googleapis.com/token")));
  assert.ok(calls.some((call) => call.href.includes("uploadType=resumable")));
  assert.ok(calls.some((call) => call.href.startsWith("https://upload.example/")));
  const denied = createDriveBackend(
    {
      GOOGLE_DRIVE_FOLDER_ID: "folder-123",
      GOOGLE_DRIVE_CLIENT_ID: "client",
      GOOGLE_DRIVE_CLIENT_SECRET: "secret",
      GOOGLE_DRIVE_REFRESH_TOKEN: "refresh",
    },
    async () => ({ ok: false, status: 401, json: async () => ({}) }),
  );
  await assert.rejects(
    () => denied.save({ project: { id } }, []),
    /token/,
  );
});

test("bundles round-trip through STORE and DEFLATE zip", async () => {
  const work = await mkdtemp(join(tmpdir(), "studio-zip-"));
  const media = Buffer.from("frame-bytes");
  const manifest = { manifestVersion: 1, note: "bundle" };
  const zipPath = join(work, "store.zip");
  await writeZip(zipPath, [
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "media/clip.bin", data: media },
  ]);
  await exec("unzip", ["-t", zipPath]);
  const extracted = join(work, "out");
  const read = await extractBundle(zipPath, extracted);
  assert.deepEqual(read, manifest);
  assert.equal(await readFile(join(extracted, "media/clip.bin"), "utf8"), "frame-bytes");
  const folder = join(work, "deflate");
  await mkdir(join(folder, "media"), { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(folder, "media/clip.bin"), media);
  const deflateZip = join(work, "deflate.zip");
  await exec("zip", ["-r", "-q", "-X", deflateZip, "manifest.json", "media"], {
    cwd: folder,
  });
  const method = readZip(await readFile(deflateZip)).find((entry) =>
    entry.name.endsWith("clip.bin"),
  );
  assert.equal(method.data.toString(), "frame-bytes");
  const again = await extractBundle(deflateZip, join(work, "deflate-out"));
  assert.equal(again.note, "bundle");
  const slipped = await evilZip(work);
  await assert.rejects(
    () => extractBundle(slipped, join(work, "evil")),
    /không an toàn|không được phép|slip/i,
  );
});

async function evilZip(work) {
  const path = join(work, "evil.zip");
  const name = Buffer.from("../evil.txt");
  const data = Buffer.from("nope");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(30 + name.length + data.length, 16);
  await writeFile(path, Buffer.concat([local, name, data, cd, name, eocd]));
  return path;
}

test(
  "save, TTL exemption, sha256 failure, list, and bundle restore",
  { timeout: 180000 },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "studio-v32-"));
    const data = join(work, "data");
    const saves = join(work, "saves");
    const source = join(work, "source.mp4");
    const portrait = join(work, "face.png");
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x224466:s=320x180:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-threads",
      "1",
      source,
    ]);
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x885533:s=64x64",
      "-frames:v",
      "1",
      portrait,
    ]);
    const port = 43141;
    const env = {
      ...process.env,
      PORT: String(port),
      DATA_DIR: data,
      SAVE_DIR: saves,
    };
    for (const key of [
      "STORAGE_BACKEND",
      "GOOGLE_DRIVE_FOLDER_ID",
      "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON",
      "GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE",
      "GOOGLE_DRIVE_CLIENT_ID",
      "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_REFRESH_TOKEN",
    ])
      delete env[key];
    const server = spawn(process.execPath, ["server/index.mjs"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    server.stdout.on("data", (chunk) => (logs += chunk));
    server.stderr.on("data", (chunk) => (logs += chunk));
    const base = `http://127.0.0.1:${port}/api`;
    const json = async (url, options) => {
      const response = await fetch(url, options);
      const body = await response.json();
      return { status: response.status, body };
    };
    try {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/health")).ok) break;
        } catch {
          /* retry */
        }
        if (i === 99) throw new Error(logs);
        await sleep(100);
      }
      const health = await json(base + "/health");
      assert.equal(health.body.version, 3);
      assert.equal(health.body.appVersion, "3.2");
      const storage = await json(base + "/storage");
      assert.equal(storage.body.local.configured, true);
      assert.equal(storage.body.drive.configured, false);
      assert.match(storage.body.drive.reason, /unconfigured/i);
      const created = await postFile(base + "/projects", source);
      assert.equal(created.scenes[0].id, 0);
      const listed = await json(base + "/projects");
      assert.ok(listed.body.projects.some((project) => project.id === created.id));
      const missingRights = await json(base + "/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "No rights" }),
      });
      assert.equal(missingRights.status, 400);
      const owned = await json(base + "/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Owned", rightsStatus: "owned" }),
      });
      assert.equal(owned.body.rightsFlagged, false);
      const internal = await json(base + "/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Internal",
          rightsStatus: "internal-only",
        }),
      });
      assert.equal(internal.body.rightsFlagged, true);
      const character = await postCharacter(base + "/characters", portrait);
      assert.equal(character.rightsFlagged, true);
      assert.equal(character.rightsStatus, "unknown");
      assert.match(character.referenceImages[0].sha256, /^[a-f0-9]{64}$/);
      const attached = await json(base + `/projects/${created.id}/character`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: character.id }),
      });
      assert.equal(attached.status, 200);
      assert.equal(attached.body.characterLock.rightsFlagged, true);
      assert.equal(
        attached.body.scenes[0].storyboard.lockedPromptPrefix,
        "LOCKED FACE same woman",
      );
      const driveSave = await json(base + `/projects/${created.id}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "drive" }),
      });
      assert.equal(driveSave.status, 424);
      assert.equal(driveSave.body.configured, false);
      assert.match(driveSave.body.error, /unconfigured/i);
      const saved = await json(base + `/projects/${created.id}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "local" }),
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.saved, true);
      const manifest = JSON.parse(
        await readFile(join(saves, created.id, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.manifestVersion, 1);
      assert.equal(manifest.project.scenes[0].id, 0);
      assert.equal(manifest.project.timeline[0].sceneId, 0);
      assert.equal(manifest.project.characterLock.rightsFlagged, true);
      assert.ok(manifest.project.scenes[0].media.every((media) => media.sha256 && media.size && media.mime));
      assert.match(manifest.project.scenes[0].effectivePrompts.image, /LOCKED FACE same woman/);
      const library = await json(base + "/saved");
      assert.ok(library.body.projects.some((project) => project.id === created.id));
      const aged = new Date(Date.now() - 7 * 3600 * 1000);
      await utimes(join(data, created.id, "project.json"), aged, aged);
      const other = await postFile(base + "/projects", source);
      await utimes(join(data, other.id, "project.json"), aged, aged);
      const again = await json(base + `/projects/${created.id}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "local" }),
      });
      assert.equal(again.status, 200);
      assert.equal((await json(base + `/projects/${created.id}`)).status, 200);
      assert.equal((await json(base + `/projects/${other.id}`)).status, 404);
      const sourceHash = manifest.project.source.sha256;
      const mediaPath = join(saves, created.id, "media/source.mp4");
      const original = await readFile(mediaPath);
      const flipped = Buffer.from(original);
      flipped[64] ^= 0xff;
      await writeFile(mediaPath, flipped);
      const mismatch = await json(base + `/saved/${created.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "local" }),
      });
      assert.equal(mismatch.status, 409);
      assert.match(mismatch.body.error, /sha256 mismatch/);
      assert.ok(mismatch.body.mismatches.some((item) => item.reason === "mismatch"));
      assert.equal(
        createHash("sha256").update(await readFile(join(data, created.id, "source.mp4"))).digest("hex"),
        sourceHash,
      );
      await writeFile(mediaPath, original);
      await rm(join(saves, created.id, "media/source.mp4"));
      const missing = await json(base + `/saved/${created.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "local" }),
      });
      assert.equal(missing.status, 409);
      assert.ok(missing.body.mismatches.some((item) => item.reason === "missing"));
      const repaired = await json(base + `/projects/${created.id}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "local" }),
      });
      assert.equal(repaired.status, 200);
      const bundlePath = join(work, "project.zip");
      const bundleResponse = await fetch(base + `/projects/${created.id}/bundle`);
      assert.equal(bundleResponse.status, 200);
      await writeFile(bundlePath, Buffer.from(await bundleResponse.arrayBuffer()));
      await exec("unzip", ["-t", bundlePath]);
      const deflateDir = join(work, "deflate-src");
      await exec("unzip", ["-q", bundlePath, "-d", deflateDir]);
      const deflateZip = join(work, "deflate.zip");
      await exec("zip", ["-r", "-q", "-X", deflateZip, "manifest.json", "media"], {
        cwd: deflateDir,
      });
      await wipe(data);
      assert.deepEqual((await json(base + "/projects")).body.projects, []);
      const restored = await json(base + `/saved/${created.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "local" }),
      });
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      assert.equal(restored.body.scenes[0].id, 0);
      assert.equal(restored.body.scenes[0].media[0].sha256, sourceHash);
      assert.equal(
        createHash("sha256").update(await readFile(join(data, created.id, "source.mp4"))).digest("hex"),
        sourceHash,
      );
      assert.equal(restored.body.characterLock.referenceImages[0].sha256, character.referenceImages[0].sha256);
      await wipe(data);
      const uploaded = await postFile(base + "/bundles", deflateZip, "bundle");
      assert.equal(uploaded.id, created.id);
      assert.equal(uploaded.scenes[0].id, 0);
      assert.equal(uploaded.timeline[0].sceneId, 0);
      assert.equal(uploaded.timeline[0].start, created.scenes[0].start);
      assert.equal(uploaded.timeline[0].duration, created.scenes[0].duration);
      assert.equal(
        createHash("sha256").update(await readFile(join(data, created.id, "source.mp4"))).digest("hex"),
        sourceHash,
      );
      const listedAgain = await json(base + "/projects");
      assert.ok(listedAgain.body.projects.some((project) => project.id === created.id));
    } finally {
      server.kill("SIGTERM");
    }
  },
);

async function postFile(url, file, field = "video") {
  const body = new FormData();
  body.append(field, new Blob([await readFile(file)]), basename(file));
  const response = await fetch(url, { method: "POST", body });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${payload.error || JSON.stringify(payload)}`);
  return payload;
}

async function postCharacter(url, image) {
  const body = new FormData();
  body.append("name", "Mai");
  body.append("rightsStatus", "unknown");
  body.append("rightsNote", "No release on file");
  body.append("face", "same woman");
  body.append("hair", "dark");
  body.append("outfit", "coat");
  body.append("lighting", "soft window");
  body.append("promptPrefix", "LOCKED FACE same woman");
  body.append("reference", new Blob([await readFile(image)]), basename(image));
  const response = await fetch(url, { method: "POST", body });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "character failed");
  return payload;
}

async function wipe(directory) {
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(directory))
    await rm(join(directory, name), { recursive: true, force: true });
}
