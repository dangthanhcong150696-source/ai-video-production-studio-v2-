import { test, expect } from "@playwright/test";
test("V3 timeline, MOCK, manual Flow import, export and download", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Studio V3" })).toBeVisible();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles("evidence/smoke-output.mp4");
  await expect(page.locator(".scene")).toHaveCount(3, { timeout: 30000 });
  await page
    .getByRole("button", { name: "Di chuyển cảnh 3 sang trái" })
    .click();
  await page.getByLabel("Thời lượng cảnh").fill("2");
  await page.getByRole("button", { name: "Lưu timeline" }).click();
  await expect(
    page.getByRole("button", { name: "Lưu timeline" }),
  ).toBeDisabled();
  await expect(page.locator(".clip").nth(1)).toContainText("Cảnh 3");
  await page.getByRole("button", { name: "Tạo ảnh MOCK" }).click();
  await expect(page.getByAltText("Ảnh cảnh 1").first()).toBeVisible();
  await page.getByLabel("Provider mode").selectOption("LIVE");
  await page
    .getByLabel("Nhập Google Flow")
    .setInputFiles("tests/fixtures/flow-import.png");
  await expect(page.locator(".clip.current")).toContainText("google-flow");
  await page.getByAltText("Ảnh cảnh 1").first().evaluate((img) => (img as HTMLImageElement).decode());
  await page.getByRole("button", { name: "Xuất video" }).click();
  await expect(
    page.getByRole("link", { name: "Tải MP4 hoàn thành" }),
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: "evidence/v3-desktop.png", fullPage: true });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Tải MP4 hoàn thành" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("studio-v3-export.mp4");
  expect(await download.failure()).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "evidence/v3-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
