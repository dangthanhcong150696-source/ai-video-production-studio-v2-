export const limits = Object.freeze({
  uploadBytes: 50 * 1024 * 1024,
  duration: 120,
  pixels: 1920 * 1080,
  maxScenes: 60,
  maxProjects: 5,
  diskBytes: 512 * 1024 * 1024,
  ttlMs: 6 * 3600000,
  processTimeout: 120000,
});
export function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
