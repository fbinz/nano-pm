const { test, expect } = require('./fixtures');

for (const [name, viewport] of Object.entries({
  desktop: { width: 1280, height: 1000 },
  mobile: { width: 390, height: 844 },
})) {
  test(`anonymous roadmap follow dialog in German at ${name} width`, async ({ appPage: page, browser }, testInfo) => {
    await page.goto('/workspaces/teams/');
    await page.getByLabel('Allowed domains for public followers').fill('mycompany.com');
    await page.getByRole('button', { name: 'Save public follower settings', exact: true }).click();
    await expect(page.getByLabel('Allowed domains for public followers')).toHaveValue('mycompany.com');
    await page.goto('/');
    await page.locator('.ws-chevron-btn').click();
    await page.getByRole('button', { name: 'Enable public roadmap' }).click();
    await page.locator('.ws-chevron-btn').click();
    const roadmap = await page.locator('#public-roadmap-link').getAttribute('href');
    const context = await browser.newContext({ viewport });
    try {
      await context.addCookies([{ name: 'django_language', value: 'de', url: new URL(page.url()).origin }]);
      const visitor = await context.newPage();
      await visitor.goto(roadmap);
      const project = visitor.locator('[data-project-subscription]', { hasText: 'API Migration' });
      await expect(visitor.locator('#roadmap-project-filter').getByText('API Migration', { exact: true })).toHaveCount(1);
      await expect(project.locator('[data-project-filter]')).toHaveAttribute('aria-pressed', 'true');
      await project.getByRole('button', { name: 'Folgen', exact: true }).click();
      const dialog = visitor.getByRole('dialog', { name: 'Projekt folgen', exact: true });
      await expect(dialog.locator('fieldset.fieldset')).toBeVisible();
      await expect(dialog.getByLabel('Teams-E-Mail-Adresse', { exact: true })).toHaveCSS('font-size', '16px');
      await expect(dialog.locator('.modal-box')).toHaveCSS('opacity', '1');
      const box = await dialog.locator('.modal-box').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      await visitor.screenshot({ path: testInfo.outputPath('public-follow-dialog.png'), fullPage: true, animations: 'disabled' });
      await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await project.getByRole('button', { name: 'Folgen', exact: true }).click();
      await dialog.getByLabel('Teams-E-Mail-Adresse', { exact: true }).fill('visitor@mycompany.com');
      await dialog.getByRole('button', { name: 'Folgen', exact: true }).click();
      await expect(project.getByRole('button', { name: 'Abonniert', exact: true })).toBeVisible();
      await expect(project.locator('[data-project-filter]')).toHaveAttribute('aria-pressed', 'true');
      const cookie = (await context.cookies()).find(c => c.name === 'nano_roadmap_follower');
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe('Lax');
      expect((await visitor.content()).includes(cookie.value)).toBe(false);
      expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await visitor.screenshot({ path: testInfo.outputPath('public-following.png'), fullPage: true });
      await project.getByRole('button', { name: 'Abonniert', exact: true }).click();
      await expect(project.getByRole('button', { name: 'Nicht mehr folgen', exact: true })).toBeVisible();
      const menuBox = await project.locator('.dropdown-content').boundingBox();
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
      await visitor.screenshot({ path: testInfo.outputPath('public-follow-menu.png'), fullPage: true, animations: 'disabled' });
      await project.getByRole('button', { name: 'Nicht mehr folgen', exact: true }).click();
      await expect(project.getByRole('button', { name: 'Folgen', exact: true })).toBeVisible();
    } finally { await context.close(); }
  });
}
