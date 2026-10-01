const { test, expect } = require('./fixtures');

for (const [name, viewport] of Object.entries({
  desktop: { width: 1280, height: 1000 },
  mobile: { width: 390, height: 844 },
})) {
  test(`Teams settings and roadmap subscriptions at ${name} width`, async ({ appPage: page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/workspaces/teams/');
    await expect(page.getByRole('heading', { name: 'Teams notifications', exact: true })).toBeVisible();
    await expect(page.getByLabel('Teams email address', { exact: true })).toHaveCount(0);
    await expect(page.getByText('One channel per workspace. Follow projects on the roadmap to be mentioned when milestones change.', { exact: true })).toHaveCount(0);
    await expect(page.locator('main a')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Workspace channel', exact: true })).toBeVisible();
    await expect(page.locator('#teams-connection-status')).toHaveClass(/\bbadge\b.*\bbadge-ghost\b/);
    await expect(page.getByRole('heading', { name: 'Recent deliveries', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('teams-disconnected.png'), fullPage: true });
    await page.getByRole('button', { name: 'Set up new webhook', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Set up new webhook', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('fieldset.fieldset')).toBeVisible();
    await expect(dialog.locator('.fieldset-legend label')).toHaveText('Microsoft Teams webhook URL');
    await expect(dialog.locator('.fieldset-legend label')).toHaveAttribute('for', 'id_teams_webhook_url');
    await expect(dialog.locator('#id_teams_webhook_url_helptext')).toHaveClass(/label/);
    await expect(dialog.getByLabel('Microsoft Teams webhook URL')).toHaveAttribute('aria-describedby', 'id_teams_webhook_url_helptext');
    await expect(dialog.getByLabel('Microsoft Teams webhook URL')).toHaveCSS('font-size', '16px');
    await expect(dialog.locator('.modal-box')).toHaveCSS('opacity', '1');
    const box = await dialog.locator('.modal-box').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath('teams-webhook-dialog.png'), fullPage: true, animations: 'disabled' });
    await dialog.getByLabel('Microsoft Teams webhook URL').fill('https://test.logic.azure.com/workflows/test?sig=test-secret');
    await dialog.getByRole('button', { name: 'Save webhook', exact: true }).click();
    await expect(page.locator('#teams-connection-status')).toHaveText('Webhook configured');
    await expect(page.locator('#teams-connection-status')).toHaveClass(/\bbadge\b.*\bbadge-success\b/);
    await expect(page.locator('#teams-connection-status svg')).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect webhook', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('teams-settings.png'), fullPage: true });
    await page.goto('/profile/');
    await page.getByLabel('Teams email address', { exact: true }).fill('demo@example.com');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByLabel('Teams email address', { exact: true })).toHaveValue('demo@example.com');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('profile.png'), fullPage: true });

    // Use a real CSRF-protected POST to enable the roadmap at both screen widths.
    await page.evaluate(async () => {
      const csrf = document.querySelector('input[name=csrfmiddlewaretoken]').value;
      await fetch('/workspaces/public-roadmap/', {
        method: 'POST', headers: { 'X-CSRFToken': csrf },
        body: new URLSearchParams({ action: 'enable' }),
      });
    });
    await page.reload();
    await page.getByRole('link', { name: 'Open public roadmap', exact: true }).last().click();
    const follow = page.locator('[data-project-subscription]', { hasText: 'API Migration' });
    await follow.getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(follow.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
    await expect(follow.getByText('API Migration', { exact: true })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('roadmap-subscriptions.png'), fullPage: true });
  });
}
