const { test, expect, login, reset } = require('./fixtures');

// =============================================================================
// Auth + first render
// =============================================================================
test.describe('auth + page render', () => {
  test('login page renders the form', async ({ page, request }) => {
    await reset(request);
    await page.goto('/accounts/login/');
    await expect(page.locator('.login-card h1')).toHaveText('nano-pm');
    await expect(page.locator('input[name=username]')).toBeVisible();
    await expect(page.locator('input[name=password]')).toBeVisible();
  });

  test('an unauthenticated request to / redirects to login', async ({ page, request }) => {
    await reset(request);
    const r = await page.goto('/');
    expect(r.url()).toContain('/accounts/login/');
  });

  test('demo / demo logs in and lands on the chart', async ({ page, request }) => {
    await reset(request);
    await login(page);
    await expect(page.locator('.brand')).toHaveText('nano-pm');
    await expect(page.locator('#zoom-controls')).toBeVisible();
  });
});

// =============================================================================
// Topbar responsiveness
// =============================================================================
test.describe('topbar responsiveness', () => {
  test('the topbar fits within a narrow viewport without horizontal overflow', async ({ appPage: page }) => {
    // 500px is a realistic phone landscape / very-narrow window. Default
    // layout overflows — check both the topbar and the page itself.
    await page.setViewportSize({ width: 500, height: 800 });
    const info = await page.evaluate(() => ({
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      topbarOverflow: document.getElementById('topbar').scrollWidth - document.getElementById('topbar').clientWidth,
    }));
    expect(info.topbarOverflow).toBeLessThanOrEqual(1);
    expect(info.pageOverflow).toBeLessThanOrEqual(1);
  });

  test('essential topbar controls remain visible at narrow widths', async ({ appPage: page }) => {
    await page.setViewportSize({ width: 500, height: 800 });
    await expect(page.locator('#zoom-controls')).toBeVisible();
    await expect(page.locator('button:has-text("Today")')).toBeVisible();
    await expect(page.locator('button:has-text("+ Project")')).toBeVisible();
    await expect(page.locator('button:has-text("Sign out")')).toBeVisible();
  });
});

// =============================================================================
// Chart structure
// =============================================================================
test.describe('chart structure', () => {
  test('seed renders 3 projects, 8 task bars, 2 milestones, 6 dep arrows', async ({ appPage: page }) => {
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);
    await expect(page.locator('.bar')).toHaveCount(8);
    // Milestones: 2 in chart rows (one diamond each in their project's header row).
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    // Dep arrows: 6, each rendered as one .hit (interactive) + one visible path.
    // Hit paths are easy to count.
    await expect(page.locator('#arrows .hit')).toHaveCount(6);
  });

  test('bars on a light project background use dark text (contrast)', async ({ appPage: page }) => {
    // Demo seeds the Infra hardening project with #f59e0b (amber). Its bars
    // need dark text — white text on amber fails contrast.
    const bar = page.locator('.bar', { hasText: 'Audit IAM policies' });
    const color = await bar.evaluate(el => getComputedStyle(el).color);
    const m = color.match(/rgb(?:a)?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    expect(m).not.toBeNull();
    const lum = (Number(m[1]) + Number(m[2]) + Number(m[3])) / (3 * 255);
    expect(lum).toBeLessThan(0.5);  // dark text
  });

  test('planned bars keep full-opacity text (no whole-bar dimming)', async ({ appPage: page }) => {
    // Demo: "Terraform module rewrites" is a planned task on the amber project.
    // The fade should be applied to the background only, not the text.
    const bar = page.locator('.bar', { hasText: 'Terraform module rewrites' });
    const opacity = await bar.evaluate(el => parseFloat(getComputedStyle(el).opacity));
    expect(opacity).toBeGreaterThan(0.95);
  });

  test('bars on a dark project background still use light text', async ({ appPage: page }) => {
    // API Migration is #3b82f6 (blue), dark — white text expected.
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const color = await bar.evaluate(el => getComputedStyle(el).color);
    const m = color.match(/rgb(?:a)?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    expect(m).not.toBeNull();
    const lum = (Number(m[1]) + Number(m[2]) + Number(m[3])) / (3 * 255);
    expect(lum).toBeGreaterThan(0.5);  // light text
  });

  test('the sidebar (sticky-left column) stays visible at any horizontal scroll position', async ({ appPage: page }) => {
    // Scroll all the way to the right edge of the chart.
    await page.evaluate(() => {
      const sc = document.getElementById('grid-scroll');
      sc.scrollLeft = sc.scrollWidth - sc.clientWidth;
    });
    // The first sticky-left cell should still be anchored at viewport-x ≈ 0.
    const cell = page.locator('.left-cell').first();
    const box = await cell.boundingBox();
    expect(box.x).toBeGreaterThan(-2);
    expect(box.x).toBeLessThan(4);
  });

  test('the sidebar width can be resized by dragging the resizer handle', async ({ appPage: page }) => {
    // Clear any persisted width from prior tests so we start at the default.
    await page.evaluate(() => localStorage.removeItem('nano-pm:sidebar-width'));
    await page.reload();

    const widthVar = () => page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'))
    );
    expect(await widthVar()).toBe(240);

    const resizer = page.locator('#sidebar-resizer');
    await expect(resizer).toBeVisible();
    const box = await resizer.boundingBox();
    const startX = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // Drag right by 80px.
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 80, y, { steps: 10 });
    await page.mouse.up();

    await page.waitForFunction(() => {
      const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'));
      return w >= 315 && w <= 325;
    });

    // Sticky left cell width follows the variable.
    const cellWidth = await page.locator('.left-cell').first().evaluate(el => el.getBoundingClientRect().width);
    expect(cellWidth).toBeGreaterThan(310);
    expect(cellWidth).toBeLessThan(330);
  });

  test('the sidebar width persists across reloads (localStorage)', async ({ appPage: page }) => {
    await page.evaluate(() => localStorage.setItem('nano-pm:sidebar-width', '300'));
    await page.reload();
    const w = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'))
    );
    expect(w).toBe(300);
  });

  test('the sidebar resize handle clamps to a minimum width', async ({ appPage: page }) => {
    await page.evaluate(() => localStorage.removeItem('nano-pm:sidebar-width'));
    await page.reload();

    const resizer = page.locator('#sidebar-resizer');
    const box = await resizer.boundingBox();
    const startX = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // Drag far to the left — past zero — and confirm the width clamps.
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX - 500, y, { steps: 10 });
    await page.mouse.up();

    const w = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'))
    );
    expect(w).toBeGreaterThanOrEqual(120);
    expect(w).toBeLessThanOrEqual(160);
  });

  test('the sidebar width can be resized via a touch drag', async ({ appPage: page }) => {
    // Touch devices don't fire mousedown/mousemove/mouseup for finger drags —
    // only pointer events (and touch events). Verify the gesture works for
    // pointerType='touch' so the resizer is usable on tablets/phones.
    await page.evaluate(() => localStorage.removeItem('nano-pm:sidebar-width'));
    await page.reload();

    const box = await page.locator('#sidebar-resizer').boundingBox();
    const startX = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.evaluate(({ sx, sy, ex }) => {
      const target = document.getElementById('sidebar-resizer');
      const make = (type, x, yy) => new PointerEvent(type, {
        pointerType: 'touch', clientX: x, clientY: yy,
        isPrimary: true, button: 0, bubbles: true, cancelable: true,
      });
      target.dispatchEvent(make('pointerdown', sx, sy));
      document.dispatchEvent(make('pointermove', ex, sy));
      document.dispatchEvent(make('pointerup', ex, sy));
    }, { sx: startX, sy: y, ex: startX + 80 });

    await page.waitForFunction(() => {
      const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'));
      return w >= 315 && w <= 325;
    });
  });

  test('the project header row stays visible when scrolling vertically past its tasks', async ({ appPage: page }) => {
    // Make the chart taller than the viewport so vertical scroll engages.
    await page.setViewportSize({ width: 1280, height: 360 });
    // Scroll past the first project's task rows.
    await page.evaluate(() => {
      document.getElementById('grid-scroll').scrollTop = 200;
    });
    // The currently-relevant project header row should still be near the top
    // of the chart area (under the time axis), not pushed off-screen.
    const proj = page.locator('.left-cell.proj').first();
    const box = await proj.boundingBox();
    // topbar (52) + axis (48) = 100; sticky should land just below.
    expect(box.y).toBeGreaterThan(80);
    expect(box.y).toBeLessThan(140);
  });

  test('today line is visible somewhere on the chart', async ({ appPage: page }) => {
    await expect(page.locator('#today-line')).toBeVisible();
  });

  test('today line height matches chart content (not the 9999px sentinel)', async ({ appPage: page }) => {
    const lineHeight = await page.locator('#today-line').evaluate(
      el => parseFloat(getComputedStyle(el).height)
    );
    const rowsHeight = await page.evaluate(() => {
      let total = 0;
      for (const r of document.querySelectorAll('.chart-row')) total += r.offsetHeight;
      return total;
    });
    // Allow a small tolerance for rounding / borders, but reject the
    // sentinel value (9999) which extends far past the chart content.
    expect(lineHeight).toBeLessThanOrEqual(rowsHeight + 8);
    expect(lineHeight).toBeGreaterThan(rowsHeight - 8);
  });

  test('arrows SVG height matches chart content (not the 9999px sentinel)', async ({ appPage: page }) => {
    const svgHeight = await page.locator('#arrows').evaluate(
      el => el.getBoundingClientRect().height
    );
    const rowsHeight = await page.evaluate(() => {
      let total = 0;
      for (const r of document.querySelectorAll('.chart-row')) total += r.offsetHeight;
      return total;
    });
    expect(svgHeight).toBeLessThanOrEqual(rowsHeight + 8);
    expect(svgHeight).toBeGreaterThan(rowsHeight - 8);
  });

  test('zoom links are present and toggleable via the URL', async ({ appPage: page }) => {
    // Default is week — its link should carry the active class.
    await expect(page.locator('#zoom-controls a.active')).toHaveText('Week');
    await page.click('#zoom-controls a:has-text("Day")');
    await expect(page).toHaveURL(/zoom=day/);
    await expect(page.locator('#zoom-controls a.active')).toHaveText('Day');
  });

  test('the px-per-day slider adjusts the chart density at the active unit', async ({ appPage: page }) => {
    // Default week zoom = 12 px/day.
    expect(await page.locator('#grid-scroll').evaluate(
      el => parseFloat(el.dataset.pxPerDay)
    )).toBe(12);

    const slider = page.locator('#zoom-slider');
    await expect(slider).toBeVisible();
    // Slider is in px/week at week zoom: range [6..24] px/day = [42..168] px/week.
    expect(await slider.getAttribute('min')).toBe('42');
    expect(await slider.getAttribute('max')).toBe('168');

    // Drag slider to its max and let the SSE patch land.
    await slider.evaluate(el => {
      el.value = el.max;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => parseFloat(document.getElementById('grid-scroll').dataset.pxPerDay) === 24,
      null,
      { timeout: 5000 }
    );
  });

  test('scrolling the wheel over the slider nudges its value', async ({ appPage: page }) => {
    const slider = page.locator('#zoom-slider');
    await slider.hover();
    const before = parseFloat(await slider.inputValue());

    // Scroll up — value should rise (more zoom-in).
    await page.mouse.wheel(0, -100);
    await expect
      .poll(async () => parseFloat(await slider.inputValue()), { timeout: 2000 })
      .toBeGreaterThan(before);

    const after = parseFloat(await slider.inputValue());
    // Scroll down — value should drop again.
    await page.mouse.wheel(0, 100);
    await expect
      .poll(async () => parseFloat(await slider.inputValue()), { timeout: 2000 })
      .toBeLessThan(after);
  });

  test('the slider remembers its value per zoom unit', async ({ appPage: page }) => {
    // Tweak slider to max at week zoom.
    await page.locator('#zoom-slider').evaluate(el => {
      el.value = el.max;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => parseFloat(document.getElementById('grid-scroll').dataset.pxPerDay) === 24,
      null, { timeout: 5000 }
    );

    // Switch to day zoom — slider should reflect day's default (36 px/day).
    await page.click('#zoom-controls a:has-text("Day")');
    await expect(page.locator('#zoom-controls a.active')).toHaveText('Day');
    expect(await page.locator('#zoom-slider').inputValue()).toBe('36');
    expect(await page.locator('#grid-scroll').evaluate(
      el => parseFloat(el.dataset.pxPerDay)
    )).toBe(36);

    // Switch back to week — the earlier tweak (168 px/week = 24 px/day) survives.
    await page.click('#zoom-controls a:has-text("Week")');
    expect(await page.locator('#zoom-slider').inputValue()).toBe('168');
    expect(await page.locator('#grid-scroll').evaluate(
      el => parseFloat(el.dataset.pxPerDay)
    )).toBe(24);
  });
});

// =============================================================================
// Task popover
// =============================================================================
test.describe('task popover', () => {
  test('the task popover anchors near the clicked bar (not at a fixed corner)', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const box = await bar.boundingBox();
    const clickX = box.x + box.width / 2;
    const clickY = box.y + box.height / 2;
    await page.mouse.click(clickX, clickY);
    await page.waitForSelector('#task-popover');
    const pop = await page.locator('#task-popover').boundingBox();
    // Popover left edge should be within a popover-width of the click;
    // top should be within a popover-height of the click. The legacy
    // (broken) state lands at a fixed (200, 200), which is hundreds of
    // pixels off in a 1280-wide viewport.
    expect(Math.abs(pop.x - clickX)).toBeLessThan(pop.width);
    expect(Math.abs(pop.y - clickY)).toBeLessThan(pop.height);
  });

  test('the project popover anchors near the clicked project header', async ({ appPage: page }) => {
    const header = page.locator('.left-cell.proj', { hasText: 'API Migration' });
    const box = await header.boundingBox();
    const clickX = box.x + box.width / 2;
    const clickY = box.y + box.height / 2;
    await page.mouse.click(clickX, clickY);
    await page.waitForSelector('#project-popover');
    const pop = await page.locator('#project-popover').boundingBox();
    expect(Math.abs(pop.x - clickX)).toBeLessThan(pop.width);
    expect(Math.abs(pop.y - clickY)).toBeLessThan(pop.height);
  });

  test('clicking a bar opens the popover with all five fields', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await expect(page.locator('#task-popover')).toBeVisible();
    await expect(page.locator('#task-popover input[name=title]')).toHaveValue(/Migrate/);
    await expect(page.locator('#task-popover input[name=start]')).toBeVisible();
    await expect(page.locator('#task-popover input[name=end]')).toBeVisible();
    await expect(page.locator('#task-popover select[name=status]')).toBeVisible();
    await expect(page.locator('#task-popover select[name=project_id]')).toBeVisible();
  });

  test('the popover surfaces predecessors and successors', async ({ appPage: page }) => {
    // Migrate /users → predecessor t1 ("Spike on auth"), successor t3 ("Cutover")
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await expect(page.locator('#task-popover .deps-list')).toContainText('Spike on auth changes');
    await expect(page.locator('#task-popover .deps-list')).toContainText('Cutover');
    await expect(page.locator('#task-popover .dep-row')).toHaveCount(2);
  });

  test('saving the title via the popover updates the bar', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await page.fill('#task-popover input[name=title]', 'Migrate users (renamed)');
    await page.click('#task-popover button[type=submit]');
    // The popover slot empties on save, and the chart re-renders with the new title.
    await expect(page.locator('#task-popover')).toHaveCount(0);
    await expect(page.locator('.bar', { hasText: 'Migrate users (renamed)' })).toBeVisible();
  });

  test('the description textarea fills the popover width', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await expect(page.locator('#task-popover')).toBeVisible();
    const titleW = await page.locator('#task-popover input[name=title]')
      .evaluate(el => el.getBoundingClientRect().width);
    const descW = await page.locator('#task-popover textarea[name=description]')
      .evaluate(el => el.getBoundingClientRect().width);
    expect(Math.abs(descW - titleW)).toBeLessThan(2);
  });

  test('a task description can be saved and is restored when the popover reopens', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await expect(page.locator('#task-popover')).toBeVisible();
    await page.fill('#task-popover textarea[name=description]', 'Notes about the migration');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('#task-popover')).toHaveCount(0);

    await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).click();
    await expect(page.locator('#task-popover textarea[name=description]'))
      .toHaveValue('Notes about the migration');
  });

  test('clicking the × on a dep row removes that dependency', async ({ appPage: page }) => {
    await expect(page.locator('#arrows .hit')).toHaveCount(6);
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await page.locator('#task-popover .dep-row .dep-remove').first().click();
    // After the dep is gone the chart re-renders; the arrow count drops by 1.
    await expect(page.locator('#arrows .hit')).toHaveCount(5);
  });
});

// =============================================================================
// Drag UX (live client preview + server commit)
// =============================================================================
test.describe('drag interactions', () => {
  test('dragging a bar later moves it (and cascades)', async ({ appPage: page }) => {
    const target = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const successor = page.locator('.bar', { hasText: 'Cutover' });

    const before = {
      targetLeft: parseFloat(await target.evaluate(el => el.style.left)),
      succLeft: parseFloat(await successor.evaluate(el => el.style.left)),
      targetStart: await target.evaluate(el => el.dataset.start),
    };

    const box = await target.boundingBox();
    // 60 px right at week zoom (12 px/day) = 5 days.
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    // Wait for the *server* commit: data-start changes only when the SSE
    // patch lands. (style.left moves locally during the drag, so it's not a
    // safe signal.)
    await page.waitForFunction(
      ([oldStart]) => {
        const el = [...document.querySelectorAll('.bar')]
          .find(b => b.textContent.includes('Migrate /users endpoints'));
        return el && el.dataset.start !== oldStart;
      },
      [before.targetStart],
      { timeout: 5000 }
    );

    const after = {
      targetLeft: parseFloat(await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).evaluate(el => el.style.left)),
      succLeft: parseFloat(await page.locator('.bar', { hasText: 'Cutover' }).evaluate(el => el.style.left)),
    };
    expect(after.targetLeft).toBeGreaterThan(before.targetLeft);
    const dT = after.targetLeft - before.targetLeft;
    const dS = after.succLeft - before.succLeft;
    expect(dS).toBeCloseTo(dT, 0);  // slack preserved → same delta
  });

  test('dragging the right edge of a bar resizes the end (start fixed)', async ({ appPage: page }) => {
    const target = page.locator('.bar', { hasText: 'Cutover' });
    const before = {
      left: parseFloat(await target.evaluate(el => el.style.left)),
      width: parseFloat(await target.evaluate(el => el.style.width)),
      end: await target.evaluate(el => el.dataset.end),
    };
    const box = await target.boundingBox();
    // Right-edge handle sits at right:0 width:6 — aim 3px from the right edge.
    await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 3 + 24, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    // Wait for the SSE re-render: data-end changes only after server commit.
    await page.waitForFunction(
      ([oldEnd]) => {
        const el = [...document.querySelectorAll('.bar')]
          .find(b => b.textContent.includes('Cutover'));
        return el && el.dataset.end !== oldEnd;
      },
      [before.end],
      { timeout: 5000 }
    );
    const after = {
      left: parseFloat(await page.locator('.bar', { hasText: 'Cutover' }).evaluate(el => el.style.left)),
      width: parseFloat(await page.locator('.bar', { hasText: 'Cutover' }).evaluate(el => el.style.width)),
    };
    expect(after.left).toBeCloseTo(before.left, 0);
    expect(after.width).toBeGreaterThan(before.width);
  });

  test('dragging the left edge of a bar moves start (end fixed)', async ({ appPage: page }) => {
    const target = page.locator('.bar', { hasText: 'Cutover' });
    const before = {
      left: parseFloat(await target.evaluate(el => el.style.left)),
      width: parseFloat(await target.evaluate(el => el.style.width)),
      start: await target.evaluate(el => el.dataset.start),
    };
    const box = await target.boundingBox();
    // Left-edge handle sits at left:0 width:6 — aim 3px in from the left.
    await page.mouse.move(box.x + 3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 3 + 24, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(
      ([oldStart]) => {
        const el = [...document.querySelectorAll('.bar')]
          .find(b => b.textContent.includes('Cutover'));
        return el && el.dataset.start !== oldStart;
      },
      [before.start],
      { timeout: 5000 }
    );
    const after = {
      left: parseFloat(await page.locator('.bar', { hasText: 'Cutover' }).evaluate(el => el.style.left)),
      width: parseFloat(await page.locator('.bar', { hasText: 'Cutover' }).evaluate(el => el.style.width)),
    };
    expect(after.left).toBeGreaterThan(before.left);
    expect(after.left + after.width).toBeCloseTo(before.left + before.width, 0);
  });

  test('the dep-handle stays interactive while the mouse traverses the bar→handle boundary', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'A/B test setup' });
    const box = await bar.boundingBox();
    // Start inside the bar to engage :hover, then move out across the boundary
    // toward the dep-handle in many small steps (i.e. real human motion).
    await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width + 6, box.y + box.height / 2, { steps: 16 });
    const pe = await bar.locator('.dep-handle').evaluate(
      el => getComputedStyle(el).pointerEvents
    );
    expect(pe).toBe('auto');
  });

  test('dragging the dep-handle shows a live drag line and clears on release', async ({ appPage: page }) => {
    const from = page.locator('.bar', { hasText: 'A/B test setup' });
    await from.hover();
    const fromBox = await from.boundingBox();
    await page.mouse.move(fromBox.x + fromBox.width + 6, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    // Mid-drag — the visual line should be present.
    await page.mouse.move(fromBox.x + fromBox.width + 120, fromBox.y + fromBox.height / 2 + 60, { steps: 4 });
    expect(await page.locator('#dep-drag').count()).toBeGreaterThan(0);
    await page.mouse.up();
    // After release, the temporary line is cleared.
    expect(await page.locator('#dep-drag').count()).toBe(0);
  });

  test('the dep-drag preview is an orthogonal arrow with an arrowhead (matches committed)', async ({ appPage: page }) => {
    const from = page.locator('.bar', { hasText: 'A/B test setup' });
    await from.hover();
    const fromBox = await from.boundingBox();
    await page.mouse.move(fromBox.x + fromBox.width + 6, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(fromBox.x + fromBox.width + 200, fromBox.y + fromBox.height / 2 + 100, { steps: 6 });
    const previewPath = page.locator('#dep-drag path[marker-end]');
    await expect(previewPath).toHaveCount(1);
    const d = await previewPath.getAttribute('d');
    // Orthogonal route: forward-flow case is M + 3 Ls, route-around case is M + 5 Ls.
    expect((d.match(/ L /g) || []).length).toBeGreaterThanOrEqual(3);
    await page.mouse.up();
  });

  test('dropping the dep-handle outside any bar surfaces a hint', async ({ appPage: page }) => {
    const from = page.locator('.bar', { hasText: 'A/B test setup' });
    const before = await page.locator('#arrows .hit').count();
    await from.hover();
    const fromBox = await from.boundingBox();
    await page.mouse.move(fromBox.x + fromBox.width + 6, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    // Drop in empty space well below the last row.
    await page.mouse.move(fromBox.x + fromBox.width + 200, fromBox.y + 400, { steps: 6 });
    await page.mouse.up();
    // No new dep created
    expect(await page.locator('#arrows .hit').count()).toBe(before);
    // A hint toast appears
    await expect(page.locator('#toast-slot .toast')).toBeVisible();
    await expect(page.locator('#toast-slot .toast')).toContainText(/task|dependency|drop/i);
  });

  test('creating a dependency does not reset the chart scroll position', async ({ appPage: page }) => {
    // Scroll the chart horizontally to a known offset.
    await page.evaluate(() => {
      document.getElementById('grid-scroll').scrollLeft = 240;
    });
    const before = await page.evaluate(() =>
      document.getElementById('grid-scroll').scrollLeft
    );
    expect(before).toBe(240);

    // Create a dep — same as the existing happy-path test.
    const from = page.locator('.bar', { hasText: 'A/B test setup' });
    const to = page.locator('.bar', { hasText: 'Audit IAM policies' });
    await from.hover();
    const fromBox = await from.boundingBox();
    const toBox = await to.boundingBox();
    await page.mouse.move(fromBox.x + fromBox.width + 6, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 12 });
    await page.mouse.up();
    // Wait for the chart re-render to land.
    await expect(page.locator('#arrows .hit')).toHaveCount(7);

    const after = await page.evaluate(() =>
      document.getElementById('grid-scroll').scrollLeft
    );
    expect(after).toBe(240);
  });

  test('dragging from a bar dep-handle to another bar creates a dependency', async ({ appPage: page }) => {
    await expect(page.locator('#arrows .hit')).toHaveCount(6);
    // Use two tasks that aren't already linked.
    const from = page.locator('.bar', { hasText: 'A/B test setup' });
    const to = page.locator('.bar', { hasText: 'Audit IAM policies' });
    await from.hover();
    const fromBox = await from.boundingBox();
    const toBox = await to.boundingBox();
    // Dep-handle now sits ~6 px past the bar's right edge.
    await page.mouse.move(fromBox.x + fromBox.width + 6, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('#arrows .hit')).toHaveCount(7);
  });

  test('a back-edge dependency is rejected with a toast', async ({ appPage: page }) => {
    // Demo has t1 → t2; attempting t2 → t1 would form a cycle.
    const from = page.locator('.bar', { hasText: 'Migrate /users endpoints' });  // t2
    const to = page.locator('.bar', { hasText: 'Spike on auth changes' });        // t1
    await from.hover();
    const fromBox = await from.boundingBox();
    const toBox = await to.boundingBox();
    await page.mouse.move(fromBox.x + fromBox.width + 6, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('#toast-slot .toast')).toBeVisible();
    await expect(page.locator('#toast-slot .toast')).toContainText(/cycle/i);
    await expect(page.locator('#arrows .hit')).toHaveCount(6);
  });
});

// =============================================================================
// Multi-select bulk move
// =============================================================================
test.describe('multi-select', () => {
  test('shift-clicking a bar toggles a selected outline (no popover)', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'A/B test setup' });
    await bar.click({ modifiers: ['Shift'] });
    await expect(bar).toHaveClass(/\bselected\b/);
    // Shift-click should NOT open the popover.
    await expect(page.locator('#task-popover')).toHaveCount(0);

    // Shift-click again to deselect.
    await page.locator('.bar', { hasText: 'A/B test setup' }).click({ modifiers: ['Shift'] });
    await expect(page.locator('.bar', { hasText: 'A/B test setup' }))
      .not.toHaveClass(/\bselected\b/);
  });

  test('Escape clears the selection', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'A/B test setup' });
    await bar.click({ modifiers: ['Shift'] });
    await expect(bar).toHaveClass(/\bselected\b/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.bar.selected')).toHaveCount(0);
  });

  test('dragging any selected bar moves the whole selection by the same delta', async ({ appPage: page }) => {
    // t6 ("A/B test setup") and t8 ("Terraform module rewrites") are both
    // leaves — moving them forward triggers no auto-cascade, so the post-
    // commit deltas are clean to compare.
    const sel1 = '.bar';
    const t6 = page.locator(sel1, { hasText: 'A/B test setup' });
    const t8 = page.locator(sel1, { hasText: 'Terraform module rewrites' });
    const before6 = parseFloat(await t6.evaluate(el => el.style.left));
    const before8 = parseFloat(await t8.evaluate(el => el.style.left));
    const oldStart6 = await t6.evaluate(el => el.dataset.start);

    await t6.click({ modifiers: ['Shift'] });
    await t8.click({ modifiers: ['Shift'] });
    await expect(page.locator('.bar.selected')).toHaveCount(2);

    // Drag t6 right by 60px (5 days at week zoom).
    const box = await t6.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    // Wait for the SSE patch — t6's data-start changes only after commit.
    await page.waitForFunction(
      ([oldStart]) => {
        const el = [...document.querySelectorAll('.bar')]
          .find(b => b.textContent.includes('A/B test setup'));
        return el && el.dataset.start !== oldStart;
      },
      [oldStart6],
      { timeout: 5000 }
    );

    const after6 = parseFloat(await page.locator('.bar', { hasText: 'A/B test setup' }).evaluate(el => el.style.left));
    const after8 = parseFloat(await page.locator('.bar', { hasText: 'Terraform module rewrites' }).evaluate(el => el.style.left));
    const d6 = after6 - before6;
    const d8 = after8 - before8;
    expect(d6).toBeGreaterThan(0);
    expect(d8).toBeCloseTo(d6, 0);  // same delta within rounding
  });

  test('dragging a non-selected bar does not move the selected ones', async ({ appPage: page }) => {
    // Selection persists across drags of unrelated bars.
    const t6 = page.locator('.bar', { hasText: 'A/B test setup' });
    await t6.click({ modifiers: ['Shift'] });

    const t8 = page.locator('.bar', { hasText: 'Terraform module rewrites' });
    const before8 = parseFloat(await t8.evaluate(el => el.style.left));
    const before6 = parseFloat(await t6.evaluate(el => el.style.left));
    const oldStart8 = await t8.evaluate(el => el.dataset.start);

    // Drag t8 (not selected) — only t8 should move.
    const box = await t8.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(
      ([oldStart]) => {
        const el = [...document.querySelectorAll('.bar')]
          .find(b => b.textContent.includes('Terraform module rewrites'));
        return el && el.dataset.start !== oldStart;
      },
      [oldStart8],
      { timeout: 5000 }
    );

    const after8 = parseFloat(await page.locator('.bar', { hasText: 'Terraform module rewrites' }).evaluate(el => el.style.left));
    const after6 = parseFloat(await page.locator('.bar', { hasText: 'A/B test setup' }).evaluate(el => el.style.left));
    expect(after8).toBeGreaterThan(before8);
    expect(after6).toBe(before6);  // t6 did not move
    // Debug: how many times did the mutation observer fire, and is the set still populated?
    // Selection survived the re-render.
    await expect(page.locator('.bar', { hasText: 'A/B test setup' }))
      .toHaveClass(/\bselected\b/);
  });
});

// =============================================================================
// Project / people management
// =============================================================================
test.describe('project & people management', () => {
  test('dragging a milestone reschedules it (data-date and visual position update)', async ({ appPage: page }) => {
    const ms = page.locator('.chart-row.proj .milestone').first();
    const before = {
      left: parseFloat(await ms.evaluate(el => el.style.left)),
      date: await ms.evaluate(el => el.dataset.date),
    };
    const box = await ms.boundingBox();
    // 60px right at week zoom (12 px/day) ≈ 5 days later.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    // Wait for the SSE chart re-render (data-date only changes after server commit).
    await page.waitForFunction(
      ([oldDate]) => {
        const el = document.querySelector('.chart-row.proj .milestone');
        return el && el.dataset.date !== oldDate;
      },
      [before.date],
      { timeout: 5000 }
    );

    const after = await page.locator('.chart-row.proj .milestone').first().evaluate(el => ({
      left: parseFloat(el.style.left),
      date: el.dataset.date,
    }));
    expect(after.left).toBeGreaterThan(before.left);
    expect(after.date > before.date).toBe(true);
  });

  test('dragging a milestone at day zoom keeps the chart at day zoom', async ({ appPage: page }) => {
    // Reproduces the "moving a milestone changes back to week mode" bug:
    // the SSE POST to /milestones/<id>/move/ carries no ?zoom=, so the server
    // re-rendered the chart at DEFAULT_ZOOM (week) instead of the active zoom.
    await page.goto('/?zoom=day');
    await expect(page.locator('#zoom-controls a.active')).toHaveText('Day');
    expect(await page.locator('#grid-scroll').evaluate(
      el => parseFloat(el.dataset.pxPerDay)
    )).toBe(36);  // day zoom

    // At day zoom (36 px/day) the seeded milestones are far past the initial
    // viewport — scroll the chart so the first one is interactable.
    const ms = page.locator('.chart-row.proj .milestone').first();
    await ms.scrollIntoViewIfNeeded();
    const beforeDate = await ms.evaluate(el => el.dataset.date);
    const box = await ms.boundingBox();
    // 72px right at day zoom (36 px/day) = 2 days.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 72, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction(
      ([oldDate]) => {
        const el = document.querySelector('.chart-row.proj .milestone');
        return el && el.dataset.date !== oldDate;
      },
      [beforeDate],
      { timeout: 5000 }
    );

    // After the SSE re-render the chart should still be at day zoom. The bug
    // resets it to week (px/day = 12).
    expect(await page.locator('#grid-scroll').evaluate(
      el => parseFloat(el.dataset.pxPerDay)
    )).toBe(36);
  });

  test('clicking a milestone diamond opens an editable popover', async ({ appPage: page }) => {
    const ms = page.locator('.chart-row.proj .milestone').first();
    const box = await ms.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('#milestone-popover');
    await expect(page.locator('#milestone-popover input[name=title]')).toBeVisible();
    await expect(page.locator('#milestone-popover input[name=date]')).toBeVisible();
  });

  test('a milestone description can be saved and is restored when the popover reopens', async ({ appPage: page }) => {
    const ms = page.locator('.chart-row.proj .milestone').first();
    const box = await ms.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('#milestone-popover');
    await page.fill('#milestone-popover textarea[name=description]', 'Cutover notes');
    await page.click('#milestone-popover button[type=submit]');
    await expect(page.locator('#milestone-popover')).toHaveCount(0);

    const reopened = page.locator('.chart-row.proj .milestone').first();
    const reopenedBox = await reopened.boundingBox();
    await page.mouse.click(reopenedBox.x + reopenedBox.width / 2, reopenedBox.y + reopenedBox.height / 2);
    await expect(page.locator('#milestone-popover textarea[name=description]'))
      .toHaveValue('Cutover notes');
  });

  test('editing a milestone title saves and updates the chart label', async ({ appPage: page }) => {
    const ms = page.locator('.chart-row.proj .milestone').first();
    const box = await ms.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('#milestone-popover');
    await page.fill('#milestone-popover input[name=title]', 'Updated milestone');
    await page.click('#milestone-popover button[type=submit]');
    await expect(page.locator('.milestone-label', { hasText: 'Updated milestone' })).toBeVisible();
  });

  test('deleting a milestone via the popover removes it from the chart', async ({ appPage: page }) => {
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    const ms = page.locator('.chart-row.proj .milestone').first();
    const box = await ms.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('#milestone-popover');
    page.once('dialog', d => d.accept());
    await page.click('#milestone-popover .danger');
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(1);
  });

  test('+ Project adds a new project row', async ({ appPage: page }) => {
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);
    await page.click('button:has-text("+ Project")');
    await expect(page.locator('.left-cell.proj')).toHaveCount(4);
  });

  test('clicking (no drag) in a project row creates a milestone at the click date', async ({ appPage: page }) => {
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);

    const row = page.locator('.chart-row.proj').first();
    const rowBox = await row.boundingBox();
    const clickX = rowBox.x + 200;
    const clickY = rowBox.y + rowBox.height / 2;

    // Compute the date that 200 px past the row's left edge maps to.
    const ppd = await page.locator('#grid-scroll').evaluate(el => parseFloat(el.dataset.pxPerDay));
    const chartStart = await page.locator('#grid-scroll').evaluate(el => el.dataset.chartStart);
    const days = Math.round(200 / ppd);
    const [y, m, d] = chartStart.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    const expectedIso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;

    await page.mouse.click(clickX, clickY);

    // Editor opens and a third diamond shows up.
    await expect(page.locator('#milestone-popover')).toBeVisible();
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(3);
    await expect(page.locator('#milestone-popover input[name=date]')).toHaveValue(expectedIso);
  });

  test('dragging (with movement) in a project row still creates a task, not a milestone', async ({ appPage: page }) => {
    const milestonesBefore = await page.locator('.chart-row.proj .milestone').count();
    const barsBefore = await page.locator('.bar').count();

    const row = page.locator('.chart-row.proj').first();
    const rowBox = await row.boundingBox();
    // Drag a clear distance so projectRowMouseDown's `moved` flag flips.
    await page.mouse.move(rowBox.x + 100, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox.x + 220, rowBox.y + rowBox.height / 2, { steps: 8 });
    await page.mouse.up();

    // Bar count goes up; milestone count does not.
    await expect(page.locator('.bar')).toHaveCount(barsBefore + 1);
    expect(await page.locator('.chart-row.proj .milestone').count()).toBe(milestonesBefore);
  });

  test('+ Add milestone in the project popover creates one and opens its editor', async ({ appPage: page }) => {
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await page.click('#project-popover #pp-add-milestone');
    // The new milestone shows up on the chart.
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(3);
    // The editor for the new milestone opens, ready to be renamed.
    await expect(page.locator('#milestone-popover')).toBeVisible();
    await expect(page.locator('#milestone-popover input[name=title]')).toHaveValue(/milestone/i);
  });

  test('the new-milestone editor opens near the new diamond (today), not where the button was', async ({ appPage: page }) => {
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await page.click('#project-popover #pp-add-milestone');
    await expect(page.locator('#milestone-popover')).toBeVisible();
    const popBox = await page.locator('#milestone-popover').boundingBox();
    // The new milestone is at today's date — its diamond sits near the today line.
    const lineBox = await page.locator('#today-line').boundingBox();
    // Popover should be horizontally close to the today line (within one popover width).
    expect(Math.abs(popBox.x - lineBox.x)).toBeLessThan(popBox.width);
  });

  test('clicking a project header opens the project popover', async ({ appPage: page }) => {
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await expect(page.locator('#project-popover input[name=name]')).toHaveValue('API Migration');
  });

  test('People modal opens, lists seeded team and accepts an Add', async ({ appPage: page }) => {
    await page.click('button:has-text("People")');
    await expect(page.locator('#modal-slot .modal')).toBeVisible();
    // Demo seeds Alex / Sam / Riley
    await expect(page.locator('#modal-slot .people-row')).toHaveCount(3);
    await page.fill('#modal-slot .add-row input[name=name]', 'Jamie Park');
    await page.click('#modal-slot .add-row button[type=submit]');
    await expect(page.locator('#modal-slot .people-row')).toHaveCount(4);
  });
});
