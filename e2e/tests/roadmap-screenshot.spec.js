const { test, expect } = require('./fixtures');

for (const [name, viewport] of Object.entries({
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
})) {
  test(`milestone roadmap and read-only sidebar at ${name} width`, async ({ appPage: page, browser }, testInfo) => {
    await page.goto('/workspaces/settings/sharing/');
    await page.getByRole('button', { name: 'Enable public roadmap' }).click();
    const roadmap = await page.locator('#public-roadmap-link').getAttribute('href');
    const context = await browser.newContext({ viewport });
    try {
      const visitor = await context.newPage();
      await visitor.goto(roadmap);
      const chart = visitor.locator('[data-roadmap-chart]');
      await chart.scrollIntoViewIfNeeded();
      await expect(chart).toBeVisible();
      await expect(visitor.locator('.roadmap-sidebar, #roadmap-project-filter')).toHaveCount(0);
      const label = chart.locator('.roadmap-project-label').filter({ hasText: 'API Migration' });
      const heading = await label.getByRole('heading', { name: 'API Migration', exact: true }).boundingBox();
      await expect(label.locator('p')).toHaveCount(0);
      const follow = await label.getByRole('button', { name: 'Follow', exact: true }).boundingBox();
      expect(follow.x).toBeGreaterThanOrEqual(heading.x + heading.width);
      expect(follow.y + follow.height / 2).toBeCloseTo(heading.y + heading.height / 2, 0);
      const geometry = await label.evaluate(el => {
        const label = el.getBoundingClientRect();
        const track = el.nextElementSibling.getBoundingClientRect();
        return { labelBottom: label.bottom, trackBottom: track.bottom, labelTop: label.top, trackTop: track.top };
      });
      expect(geometry.labelBottom).toBeCloseTo(geometry.trackBottom, 0);
      expect(geometry.labelTop).toBeCloseTo(geometry.trackTop, 0);
      expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // Start around today, even when all milestones lie in the future.
      expect(await chart.evaluate(el => {
        const chartBox = el.getBoundingClientRect();
        const label = el.querySelector('.roadmap-project-label').getBoundingClientRect();
        const today = el.querySelector('.roadmap-today-line').getBoundingClientRect();
        return today.left > label.right && today.right < chartBox.right;
      })).toBe(true);
      await visitor.screenshot({ path: testInfo.outputPath('roadmap.png'), fullPage: true, animations: 'disabled' });
      const projectName = label.getByRole('button', { name: 'API Migration', exact: true });
      await projectName.click();
      const details = visitor.locator('#drawer');
      await expect(details.getByRole('heading', { name: 'API Migration', exact: true })).toBeVisible();
      await expect(details).toContainText('Move public API traffic to the new v2 platform.');
      await expect(details).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
      const detailsBox = await details.boundingBox();
      expect(detailsBox.x).toBeGreaterThanOrEqual(0);
      expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(viewport.width);
      await visitor.screenshot({ path: testInfo.outputPath('project-sidebar.png'), fullPage: true, animations: 'disabled' });
      await visitor.keyboard.press('Escape');
      await expect(details).not.toBeVisible();
      await expect(projectName).toBeFocused();
      const milestone = visitor.getByRole('button', { name: /v2 API beta/ });
      await milestone.scrollIntoViewIfNeeded();
      await milestone.click();
      const drawer = visitor.locator('#drawer');
      await expect(drawer.getByRole('heading', { name: 'v2 API beta' })).toBeVisible();
      const close = drawer.getByRole('button', { name: 'Close', exact: true });
      await expect(close).toBeFocused();
      await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
      const box = await drawer.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      await visitor.screenshot({ path: testInfo.outputPath('milestone-sidebar.png'), fullPage: true, animations: 'disabled' });
      await visitor.keyboard.press('Escape');
      await expect(drawer).not.toBeVisible();
      await expect(milestone).toBeFocused();
    } finally {
      await context.close();
    }
  });
}
