import { test, expect } from "@playwright/test";
test("Storyboard V3.1 edits prompts and binds manual media to stable scenes", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Studio V3.1" }),
  ).toBeVisible();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles("evidence/smoke-output.mp4");
  await expect(page.locator(".story-card")).toHaveCount(3, { timeout: 30000 });
  await page
    .getByAltText("Cảnh 1 đầu", { exact: true })
    .evaluate((el) => (el as HTMLImageElement).decode());
  await page
    .getByAltText("Cảnh 1 cuối", { exact: true })
    .evaluate((el) => (el as HTMLImageElement).decode());
  await page
    .getByLabel("Prompt ảnh cảnh 1", { exact: true })
    .fill("A green environment. Preserve identity from references.");
  await page
    .getByLabel("Prompt chuyển động cảnh 1", { exact: true })
    .fill("Slow camera move, 2 seconds, no morphing.");
  await page.getByLabel("Skill cho cảnh 1", { exact: true }).selectOption("continuity");
  await page.getByRole("button", { name: "Áp dụng Skill vào prompt", exact: true }).first().click();
  await expect(page.getByLabel("Prompt ảnh cảnh 1", { exact: true })).toHaveValue(/\\[SKILL:continuity\\]/);
  await expect(page.getByLabel("Prompt chuyển động cảnh 1", { exact: true })).toHaveValue(/\\[SKILL:continuity\\]/);
  await page.getByRole("button", { name: "Áp dụng Skill vào prompt", exact: true }).first().click();
  const promptOnce = await page.getByLabel("Prompt ảnh cảnh 1", { exact: true }).inputValue();
  expect(promptOnce.match(/\\[SKILL:continuity\\]/g)?.length).toBe(1);
  await page
    .getByRole("button", { name: "Lưu prompt cảnh 1", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lưu prompt cảnh 1", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Ảnh Nano Banana cảnh 1", { exact: true })
    .setInputFiles("tests/fixtures/flow-import.png");
  await expect(
    page.getByAltText("Ảnh Nano đã nhập cảnh 1", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Omni provider cảnh 1", { exact: true })
    .selectOption("Omni Plus");
  await page
    .getByLabel("Clip Omni cảnh 1", { exact: true })
    .setInputFiles("evidence/v3-1-output.mp4");
  await expect(page.locator('.story-card[data-scene-id="0"]')).toContainText(
    "Omni Plus",
  );
  await expect(
    page.getByAltText("Ảnh Nano đã nhập cảnh 1", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Di chuyển cảnh 3 sang trái", exact: true })
    .click();
  await page.getByLabel("Thời lượng cảnh", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Lưu timeline", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Lưu timeline", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".story-card").nth(1)).toHaveAttribute(
    "data-scene-id",
    "2",
  );
  await page
    .getByLabel("Clip Omni cảnh 3", { exact: true })
    .setInputFiles("evidence/v3-1-output.mp4");
  await expect(page.locator('.story-card[data-scene-id="2"]')).toContainText(
    "Omni Flash",
  );
  await expect(
    page.getByLabel("Prompt ảnh cảnh 1", { exact: true }),
  ).toHaveValue(/\\[SKILL:continuity\\]/);
  await page.getByRole("button", { name: "Xuất video" }).click();
  await expect(
    page.getByRole("link", { name: "Tải MP4 hoàn thành" }),
  ).toBeVisible({ timeout: 60000 });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Tải MP4 hoàn thành" }).click(),
  ]);
  expect(await download.failure()).toBeNull();
  await page.screenshot({
    path: "evidence/v3-1-storyboard-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "evidence/v3-1-storyboard-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
