const { test, expect } = require('./fixtures');

for (const [name, viewport] of Object.entries({
  desktop: { width: 1280, height: 1000 },
  tablet: { width: 800, height: 1000 },
  mobile: { width: 390, height: 844 },
})) {
  for (const language of ['en', 'de']) {
    test(`workspace settings sections fit ${name} screens in ${language}`, async ({ appPage: page }, testInfo) => {
      if (language === 'de') {
        await page.locator('.lang-btn', { hasText: 'DE' }).click();
        await expect(page.locator('.lang-btn', { hasText: 'DE' })).toHaveClass(/active/);
      }
      await page.setViewportSize(viewport);
      for (const [section, label] of [
        ['', language === 'de' ? 'Allgemein' : 'General'],
        ['workload/', language === 'de' ? 'Arbeitsverteilung' : 'Workload'],
        ['integrations/', language === 'de' ? 'Integrationen' : 'Integrations'],
        ['sharing/', 'Roadmap'],
      ]) {
        await page.goto('/workspaces/settings/' + section);
        await expect(page.locator('main').getByRole('heading', { name: label, exact: true })).toBeVisible();
        if (name === 'mobile') {
          await expect(page.locator('#workspace-settings-section option:checked')).toHaveText(label);
        } else {
          const nav = page.locator('main nav');
          await expect(nav.locator('[aria-current="page"]')).toHaveText(label);
          const links = await nav.getByRole('link').all();
          const boxes = await Promise.all(links.map(link => link.boundingBox()));
          for (let i = 1; i < boxes.length; i++) {
            expect(boxes[i].y).toBeCloseTo(boxes[0].y, 0);
            expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width);
          }
          const navBox = await nav.boundingBox();
          const headingBox = await page.locator('main').getByRole('heading', { name: label, exact: true }).boundingBox();
          expect(headingBox.y).toBeGreaterThanOrEqual(navBox.y + navBox.height);
          expect(headingBox.x).toBeCloseTo(navBox.x, 0);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`settings-${section.replace('/', '') || 'general'}.png`), fullPage: true });
      }
    });
  }
}
