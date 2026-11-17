import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const base = process.env.STUDIO_URL || "http://127.0.0.1:3012";
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(base + "/api/health")).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
assert.equal((await (await fetch(base + "/api/health")).json()).version, 3);
const ui = await fetch(base + "/");
assert.equal(ui.status, 200);
assert.match(await ui.text(), /AI Video Production Studio V3/);
const form = new FormData();
form.append(
  "video",
  new Blob([await readFile("evidence/smoke-output.mp4")]),
  "fixture.mp4",
);
const response = await fetch(base + "/api/projects", {
  method: "POST",
  body: form,
});
const p = await response.json();
assert.equal(response.status, 201, JSON.stringify(p));
assert.ok(p.scenes.every((s) => s.duration <= 8.001));
const start = await fetch(base + `/api/projects/${p.id}/export`, {
  method: "POST",
});
assert.equal(start.status, 202);
let job;
for (let i = 0; i < 600; i++) {
  job = await (await fetch(base + `/api/projects/${p.id}/export`)).json();
  if (job.status !== "running") break;
  await new Promise((r) => setTimeout(r, 100));
}
assert.equal(job.status, "done", JSON.stringify(job));
const result = await fetch(base + `/api/projects/${p.id}/download`);
assert.equal(result.status, 200);
await writeFile(
  "/tmp/studio-container-output.mp4",
  Buffer.from(await result.arrayBuffer()),
);
console.log(
  JSON.stringify({
    health: 200,
    ui: 200,
    upload: response.status,
    scenes: p.scenes.length,
    export: job.status,
    download: result.status,
    duration: p.duration,
  }),
);
