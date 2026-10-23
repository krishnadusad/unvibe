/**
 * Custom guides against mock mode (quick component checks; the mock's
 * canned guide covers the demo's header-unfolding code and its unit
 * tests, leaving the socket-level test and the changelog out; a request
 * naming "today" asks a question first — see `mock/index.ts`).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./network-guard.js";

const CONN = "src-urllib3-connection.py";
const TCONN = "test-test_connection.py";
const TSOCK = "test-with_dummyserver-test_socketlevel.py";
const CHANGELOG = "changelog-1362.bugfix.rst";
const file = (key: string): string => `[id="F-${key}"]`;
const SUGGESTION = "Worth a test where the fold uses a bare LF";

test.beforeEach(async ({ page }) => {
  await page.goto("/review/demo");
  await expect(page.locator(file(CONN))).toBeVisible();
});

async function createGuide(page: Page, prompt: string): Promise<void> {
  await page.getByRole("button", { name: "+ New guide" }).click();
  const box = page.getByRole("textbox", { name: "New guide request" });
  await box.fill(prompt);
  await box.press("Enter");
  await expect(page).toHaveURL(/\/review\/demo\/guide\/gd-[0-9a-f]+$/);
}

/** Switch guides in-app (a reload would reset the mock's state). */
async function selectGuide(page: Page, name: string | RegExp): Promise<void> {
  await page.getByTestId("guide-select").click();
  await page.getByRole("option", { name }).click();
}

async function openCommentsMenu(page: Page): Promise<ReturnType<Page["locator"]>> {
  await page.locator('#reviewbar [data-cm=""]').click();
  const panel = page.locator(".cmenu");
  await expect(panel).toBeVisible();
  return panel;
}

test("the main guide shows only a New guide affordance until a guide exists", async ({ page }) => {
  await expect(page.getByRole("button", { name: "+ New guide" })).toBeVisible();
  await expect(page.getByTestId("guide-select")).toHaveCount(0);
});

test("a new guide streams in, scopes the diff, and filters by its own plotlines", async ({ page }) => {
  await createGuide(page, "Security review: only the header parsing");
  const intro = page.locator(".cg-intro");
  await expect(intro).toHaveAttribute("data-guide-status", "ready");
  await expect(page.locator(".eyebrow")).toHaveText("Custom guide");
  await expect(intro.locator(".cg-turns")).toContainText("Security review: only the header parsing");
  await expect(page.getByTestId("guide-scope")).toHaveText("5 hunks · 1 commit");
  // Its own sections and plotlines.
  await expect(page.locator("#page").getByText("Where folded values get unfolded").first()).toBeVisible();
  await expect(page.locator("#page").getByText("How the tests pin it down").first()).toBeVisible();
  const box = page.locator(".plotlines");
  await expect(box.locator(".plname", { hasText: "Normalize on read" })).toBeVisible();
  await expect(box.locator(".plname", { hasText: "Pin it with tests" })).toBeVisible();
  await expect(box.locator(".plname", { hasText: "Unfold folded values" })).toHaveCount(0);

  // The diff shows only the guide's hunks.
  await expect(page.locator('[data-filterchip="guide"]')).toContainText("Guide: Security review");
  await expect(page.locator(file(CONN))).toBeVisible();
  await expect(page.locator(file(TCONN))).toBeVisible();
  await expect(page.locator(file(TSOCK))).toHaveCount(0);
  await expect(page.locator(file(CHANGELOG))).toHaveCount(0);
  await expect(page.locator(".dhunk-h .ptag", { hasText: "Normalize on read" }).first()).toBeVisible();

  // Picking one of its plotlines filters within the guide.
  await box.locator('[data-plotpick="g-tests"]').click();
  await expect(page.locator('[data-filterchip="plotline"]')).toContainText("Plotline: Pin it with tests");
  await expect(page.locator(file(CONN))).toHaveCount(0);
  await expect(page.locator(file(TCONN))).toBeVisible();
  await expect(page.locator(file(TSOCK))).toHaveCount(0);

  // × on the guide chip returns to the main guide and the full diff.
  await page
    .locator('[data-filterchip="guide"]')
    .getByRole("button", { name: "Back to the main guide" })
    .click();
  await expect(page).toHaveURL(/\/review\/demo$/);
  await expect(page.locator('[data-filterchip="guide"]')).toHaveCount(0);
  await expect(page.locator('[data-filterchip="plotline"]')).toHaveCount(0);
  await expect(page.locator(file(TSOCK))).toBeVisible();
  await expect(page.locator(".plotlines .plname", { hasText: "Unfold folded values" })).toBeVisible();
  // The switcher now lists the guide.
  await expect(page.getByTestId("guide-select")).toContainText("Main guide");
});

test("an ambiguous request asks a question; the answer continues the guide", async ({ page }) => {
  await createGuide(page, "What changed in today's commits?");
  const intro = page.locator(".cg-intro");
  await expect(intro).toHaveAttribute("data-guide-status", "needs-input");
  const ask = page.getByRole("region", { name: "Question from the agent" });
  await expect(ask).toContainText("Which commits count as today's");
  const answer = ask.getByRole("textbox", { name: "Your answer" });
  await answer.fill("The ones authored today");
  await answer.press("Enter");
  await expect(intro).toHaveAttribute("data-guide-status", "ready");
  await expect(intro.locator(".cg-turns li")).toHaveCount(3);
  await expect(intro.locator(".cg-turns")).toContainText("The ones authored today");
  await expect(page.locator(".plotlines .plname", { hasText: "Normalize on read" })).toBeVisible();
});

test("suggested comments stay in the guide until marked for the PR", async ({ page }) => {
  await createGuide(page, "Review the header handling");
  const guideUrl = page.url();
  const list = page.getByRole("region", { name: "Suggested comments" });
  await expect(list).toContainText(SUGGESTION);
  // Shown in the guide's diff too.
  await expect(page.locator("#right").getByText(SUGGESTION).first()).toBeVisible();

  // Not on the main guide.
  await page
    .locator('[data-filterchip="guide"]')
    .getByRole("button", { name: "Back to the main guide" })
    .click();
  await expect(page).toHaveURL(/\/review\/demo$/);
  await expect(page.locator("#right").getByText(SUGGESTION)).toHaveCount(0);
  let panel = await openCommentsMenu(page);
  await expect(panel).not.toContainText(SUGGESTION);
  await page.keyboard.press("Escape");

  // Mark it inside the guide; it then shows everywhere, in the Outbox.
  await selectGuide(page, /Review the header handling/);
  await expect(page).toHaveURL(guideUrl);
  await list.getByRole("button", { name: "Mark for PR" }).click();
  await expect(list.getByRole("button", { name: "Marked for PR" })).toBeVisible();
  await page
    .locator('[data-filterchip="guide"]')
    .getByRole("button", { name: "Back to the main guide" })
    .click();
  await expect(page).toHaveURL(/\/review\/demo$/);
  panel = await openCommentsMenu(page);
  await panel.locator('[data-cmtab="outbox"]').click();
  await expect(panel).toContainText(SUGGESTION);
});

test("deleting a guide returns to the main guide and removes its pages", async ({ page }) => {
  await createGuide(page, "Only the tests");
  const guideUrl = page.url();
  await expect(page.locator(".cg-intro")).toHaveAttribute("data-guide-status", "ready");
  await page.getByRole("button", { name: "Guide actions" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("menuitem", { name: "Delete guide" }).click();
  await expect(page).toHaveURL(/\/review\/demo$/);
  await expect(page.getByTestId("guide-select")).toHaveCount(0);
  await expect(page.locator(file(TSOCK))).toBeVisible();
  await expect(page.locator('[data-filterchip="guide"]')).toHaveCount(0);
  // Its route no longer resolves (in-app navigation keeps the mock state).
  await page.evaluate((url) => {
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, guideUrl);
  await expect(page.getByTestId("guide-missing")).toBeVisible();
  await expect(page.locator("#page").getByText("Where folded values get unfolded")).toHaveCount(0);
});
