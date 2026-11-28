import { expect, test, type Page } from "@playwright/test";

function attachErrorGuards(page: Page) {
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];

  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("response", (res) => {
    if (res.status() >= 500 && !res.url().includes("/api/health")) {
      serverErrors.push(`${res.status()} ${res.url()}`);
    }
  });

  return {
    assertClean() {
      expect(pageErrors, `Uncaught page errors: ${pageErrors.join("; ")}`).toEqual([]);
      expect(serverErrors, `Unexpected 5xx responses: ${serverErrors.join("; ")}`).toEqual([]);
    },
  };
}

test.describe("ALO Learning Journey E2E", () => {
  test("public pages render without client or server errors", async ({ page }) => {
    const guard = attachErrorGuards(page);

    for (const route of ["/login", "/contact", "/marketingos"]) {
      const res = await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(res?.status(), `${route} HTTP status`).toBe(200);
      await expect(page.locator("body")).not.toBeEmpty();
    }

    await page.goto("/login", { waitUntil: "networkidle" });
    await expect(page.locator("#admin-email")).toBeVisible();
    await expect(page.locator("#admin-password")).toBeVisible();

    await page.goto("/marketingos", { waitUntil: "networkidle" });
    await expect(page.locator("h1").first()).toBeVisible();

    guard.assertClean();
  });

  test("unauthenticated requests fail closed on protected boundaries", async ({ request, page }) => {
    const rootRes = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(rootRes).not.toBeNull();
    expect(page.url()).toContain("/login");

    for (const path of [
      "/api/social-accounts",
      "/api/v1/billing/usage",
      "/api/v1/calls",
      "/api/v1/voice-agents",
      "/api/approvals",
    ]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(
        res.status() === 401 || res.status() === 307 || res.status() === 302,
        `${path} unauthenticated status=${res.status()}`,
      ).toBeTruthy();
    }
  });

  test("public contact form validates and submits cleanly", async ({ page }) => {
    const guard = attachErrorGuards(page);
    await page.goto("/contact", { waitUntil: "networkidle" });

    await page.fill("#contact-name", "E2E Parent");
    await page.fill("#contact-email", "e2e-parent@example.com");
    await page.fill("#contact-phone", "01805020103");
    await page.fill("#contact-topic", "Admissions");
    await page.fill(
      "#contact-message",
      "Checking admissions details from Playwright browser verification.",
    );

    const [postRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/contact") && r.request().method() === "POST"),
      page.getByRole("button", { name: /send message/i }).click(),
    ]);
    expect([200, 202]).toContain(postRes.status());
    await expect(page.locator("[role='status']")).toBeVisible();
    guard.assertClean();
  });

  test("admin signs in at /login and opens primary ALO console", async ({ page }) => {
    const adminEmail = process.env.PLAYWRIGHT_ADMIN_EMAIL;
    const adminPassword = process.env.PLAYWRIGHT_ADMIN_PASSWORD;
    test.skip(!adminEmail || !adminPassword, "PLAYWRIGHT_ADMIN_EMAIL/PASSWORD not set");

    const guard = attachErrorGuards(page);
    await page.goto("/login", { waitUntil: "networkidle" });

    await page.fill("#admin-email", adminEmail!);
    await page.fill("#admin-password", adminPassword!);

    const submitBtn = page.getByRole("button", { name: /sign in securely/i });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    await page.waitForURL((url) => url.pathname === "/", { timeout: 20_000 });
    await expect(page.locator("body")).toContainText(/ALO|আলো/i);
    guard.assertClean();
  });

  test("tenant signs up on /dashboard and navigates real Billing, Social Accounts, and Contact Center flows", async ({
    page,
  }) => {
    const guard = attachErrorGuards(page);
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const email = `e2e-tenant-${suffix}@alolabs.invalid`;
    const password = `E2ePass#${suffix}!`;

    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: "Sign Up" }).click();

    const signUpPanel = page.getByRole("tabpanel", { name: "Sign Up" });
    await signUpPanel.getByPlaceholder("John Doe").fill("E2E Tenant Owner");
    await signUpPanel.getByPlaceholder("you@company.com").fill(email);
    await signUpPanel.getByPlaceholder("Create password").fill(password);
    await signUpPanel.getByPlaceholder("Company").fill(`ALO E2E Org ${suffix}`);
    await signUpPanel.getByPlaceholder("Industry").fill("Education");

    const [regRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/register") && r.request().method() === "POST"),
      signUpPanel.getByRole("button", { name: /create account/i }).click(),
    ]);
    expect(regRes.status(), "Tenant signup should succeed").toBeLessThan(400);

    await expect(page.getByText("CEO Dashboard").first()).toBeVisible();

    const sidebar = page.locator("aside");

    // Billing view: opens real Plan Selection dialog instead of placeholder toast
    await sidebar.getByRole("button", { name: /^Billing$/i }).click();
    await expect(page.getByRole("heading", { name: /billing & usage/i })).toBeVisible();
    const planTrigger = page.getByRole("button", { name: /browse plans|change plan/i });
    await expect(planTrigger).toBeVisible();
    await planTrigger.click();
    await expect(page.getByRole("dialog")).toContainText(/Choose Subscription Plan/i);
    await page.getByRole("button", { name: "Cancel" }).click();

    // Social Accounts view: wizard uses Verify & Connect without fake simulation button
    await sidebar.getByRole("button", { name: /Social Accounts/i }).click();
    await expect(page.getByText(/Social Accounts/i).first()).toBeVisible();

    // Contact Center view: renders dial pad & queue table cleanly
    await sidebar.getByRole("button", { name: /Contact Center/i }).click();
    await expect(page.getByText(/Queued Calls/i)).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Support #1234");

    guard.assertClean();
  });
});
