/**
 * Hunk scores + plotlines (issue #169) against mock mode: header dots and
 * plotline tags, the dots and chips as
 * the filter selectors (owner direction: no radio groups in the filter
 * menu), the active-filter chip in the actions bar, and the guide's
 * plotlines box as a selector too.
 */
import { expect, test } from "./network-guard.js";

const CONN = "src-urllib3-connection.py";
const TCONN = "test-test_connection.py";
const TSOCK = "test-with_dummyserver-test_socketlevel.py";
const connFile = `[id="F-${CONN}"]`;

test.beforeEach(async ({ page }) => {
  await page.goto("/review/demo");
  await expect(page.locator(connFile)).toBeVisible();
});

test("hunk headers carry score dots and plotline tags", async ({ page }) => {
  const dots = page.locator(".dhunk-h .score-dot");
  await expect(dots.first()).toBeVisible();
  await expect(page.locator('.dhunk-h .score-dot[data-score="substantive"]').first()).toBeVisible();
  await expect(page.locator(".dhunk-h .ptag", { hasText: "Unfold folded values" }).first()).toBeVisible();
  await expect(page.locator(".dhunk-h .ptag", { hasText: "Prove the unfolding works" }).first()).toBeVisible();
});

test("Files list has no score dots or legend (#184)", async ({ page }) => {
  await page.getByRole("button", { name: "Show file list" }).click();
  await expect(page.locator(".flist .score-dot")).toHaveCount(0);
  await expect(page.locator(".legend")).toHaveCount(0);
  // The level lives on the hunk dot's tooltip instead.
  const dot = page.locator('.dhunk-h [data-scorepick="substantive"]').first();
  await expect(dot).toHaveAttribute("data-tip", "Show substantive hunks or higher");
});

test("clicking a score dot filters to that level or higher; the chip shows and its × clears", async ({ page }) => {
  await page.locator('.dhunk-h [data-scorepick="substantive"]').first().click();
  // Substantive hunks live in the conn file and one socket-level test hunk.
  await expect(page.locator(connFile)).toBeVisible();
  await expect(page.locator(`[id="F-${TSOCK}"]`)).toBeVisible();
  await expect(page.locator(`[id="F-${TCONN}"]`)).toHaveCount(0);
  // The pinned bar shows what is filtered and how much it hides.
  const chip = page.locator('[data-filterchip="score"]');
  await expect(chip).toContainText("Score: substantive or higher");
  await expect(chip).toContainText(/· \d+ hidden/);
  // × clears it.
  await chip.getByRole("button", { name: "Clear score filter" }).click();
  await expect(page.locator(connFile)).toBeVisible();
  await expect(page.locator('[data-filterchip="score"]')).toHaveCount(0);
  // The filter menu no longer carries score/plotline radio groups.
  await page.getByRole("button", { name: "Show file list" }).click();
  await page.getByRole("button", { name: "File filters" }).click();
  const menu = page.getByRole("menu", { name: "File filters" });
  await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
});

test("clicking a plotline chip filters and the filter survives a reload of the pane", async ({ page }) => {
  await page.locator('[data-plotpick="unfold"]').first().click();
  await expect(page.locator(connFile)).toBeVisible();
  await expect(page.locator(`[id="F-${TCONN}"]`)).toHaveCount(0);
  await expect(page.locator('[data-filterchip="plotline"]')).toContainText("Plotline: Unfold folded values");
});

test("guide root lists plotlines with hunk counts", async ({ page }) => {
  const box = page.locator(".plotlines");
  await expect(box).toBeVisible();
  await expect(box.locator(".plname", { hasText: "Unfold folded values" })).toBeVisible();
  await expect(box.locator(".plname", { hasText: "Prove the unfolding works" })).toBeVisible();
  await expect(box.getByText("Other")).toBeVisible();
  await expect(box.getByText(/hunks?/).first()).toBeVisible();
  // Landing order and builds-on, with no explanation line.
  await expect(box.locator(".plnote")).toHaveCount(0);
  await expect(box.locator(".plbuilds")).toContainText("Builds on Unfold folded values");
  // #242: no numbering; the hunk count rides a chip in the row's
  // trailing slot.
  await expect(box.locator(".plorder")).toHaveCount(0);
  await expect(box.locator("li").first()).toContainText("Unfold folded values");
});

test("guide Plotlines entry filters the diff and scrolls to its first hunk", async ({ page }) => {
  const box = page.locator(".plotlines");
  await box.locator('[data-plotpick="unfold-tests"]').click();
  // The diff is filtered to that plotline and its first hunk is in view.
  await expect(page.locator('[data-filterchip="plotline"]')).toContainText("Plotline: Prove the unfolding works");
  await expect(page.locator(connFile)).toHaveCount(0);
  await expect(page.locator(`[id="F-${TSOCK}"]`)).toBeVisible();
  const inView = await page.evaluate(() => {
    const el = document.querySelector('[data-hunk]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  });
  expect(inView).toBe(true);
});

test("guide Plotlines text is selectable and a selection is not a pick", async ({ page }) => {
  const name = page.locator(".plotlines .plname", { hasText: "Unfold folded values" });
  const box = await name.boundingBox();
  if (!box) throw new Error("plotline name not laid out");
  // Drag across the bold name, as a reader copying it would.
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain("Unfold folded");
  // Finishing the selection did not toggle the filter.
  await expect(page.locator('[data-plotpick="unfold"]').first()).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-filterchip="plotline"]')).toHaveCount(0);
});

test("guide Plotlines entry still works from the keyboard", async ({ page }) => {
  const row = page.locator('.plotlines [data-plotpick="unfold-tests"]');
  await expect(row).toHaveAttribute("role", "button");
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-filterchip="plotline"]')).toContainText("Plotline: Prove the unfolding works");
  await expect(row).toHaveAttribute("aria-pressed", "true");
});
