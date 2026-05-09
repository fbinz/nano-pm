const { test, expect } = require('./fixtures');

// ============================================================================
// Welcome flow
// ============================================================================
test.describe('welcome', () => {
  test('shows welcome card on empty data', async ({ page, appUrl }) => {
    await page.goto(appUrl);
    await expect(page.locator('#welcome')).toBeVisible();
    await expect(page.locator('#welcome h2')).toHaveText(/Welcome to nano-pm/i);
  });

  test('"Start fresh" dismisses welcome and leaves chart empty', async ({ page, appUrl }) => {
    await page.goto(appUrl);
    await page.click('#welcome-fresh');
    await expect(page.locator('#welcome')).toBeHidden();
    await expect(page.locator('.bar')).toHaveCount(0);
    await expect(page.locator('.left-cell.proj')).toHaveCount(0);
  });

  test('"Try a demo" populates 3 projects, 8 tasks, 2 milestones, 6 deps', async ({ page, appUrl }) => {
    await page.goto(appUrl);
    await page.click('#welcome-demo');
    await expect(page.locator('#welcome')).toBeHidden();
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);
    await expect(page.locator('.bar')).toHaveCount(8);
    // .milestone class is reused for the data div entries and the chart diamonds.
    // Scope to chart rows for the visual count.
    await expect(page.locator('.chart-row .milestone')).toHaveCount(2);
    await expect(page.locator('#data .dep')).toHaveCount(6);
  });
});

// ============================================================================
// Interactions (after loading the demo)
// ============================================================================
test.describe('interactions with demo', () => {
  test.beforeEach(async ({ page, appUrl }) => {
    await page.goto(appUrl);
    await page.click('#welcome-demo');
    await expect(page.locator('.bar')).toHaveCount(8);
  });

  test('clicking a bar opens the inline popover with the five fields', async ({ page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await expect(page.locator('#popover')).toBeVisible();
    await expect(page.locator('#po-title')).toHaveValue(/Migrate \/users/);
    await expect(page.locator('#po-start')).toBeVisible();
    await expect(page.locator('#po-end')).toBeVisible();
    await expect(page.locator('#po-status')).toBeVisible();
    await expect(page.locator('#po-assignees')).toBeVisible();
  });

  test('editing the title in the popover updates the bar text', async ({ page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    const title = page.locator('#po-title');
    await title.fill('Migrate users (renamed)');
    await title.dispatchEvent('change');
    await page.click('#po-done');
    await expect(page.locator('.bar', { hasText: 'Migrate users (renamed)' })).toBeVisible();
  });

  test('dragging the LEFT edge of a bar moves the start date but keeps the end date', async ({ page }) => {
    const target = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const before = await target.evaluate(el => ({
      left: parseFloat(el.style.left),
      width: parseFloat(el.style.width),
    }));
    const box = await target.boundingBox();

    // Mouse-down on the leftmost ~3px of the bar — that should hit a left resize
    // handle, not trigger the body-of-bar move gesture.
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    // ~3 days at week zoom (12 px/day)
    await page.mouse.move(box.x + 38, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    const after = await target.evaluate(el => ({
      left: parseFloat(el.style.left),
      width: parseFloat(el.style.width),
    }));

    // Start moved later
    expect(after.left).toBeGreaterThan(before.left);
    // End stayed put — right edge unchanged
    expect(after.left + after.width).toBeCloseTo(before.left + before.width, 0);
  });

  test('bars do not clip their child handles (overflow visible)', async ({ page }) => {
    const bar = page.locator('.bar').first();
    const overflow = await bar.evaluate(el => getComputedStyle(el).overflow);
    expect(overflow).toBe('visible');
  });

  test('the dragged bar follows the cursor live during drag, not only on release', async ({ page }) => {
    const target = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const startLeft = await target.evaluate(el => parseFloat(el.style.left));
    const box = await target.boundingBox();

    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    // ~5 days at week zoom (12 px/day)
    await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 8 });

    // Bar should be visibly displaced *while the mouse is still down*.
    const liveLeft = await target.evaluate(el => parseFloat(el.style.left));

    await page.mouse.up();
    expect(liveLeft).toBeGreaterThan(startLeft);
  });

  test('dragging a bar later moves it and cascades successors with slack preserved', async ({ page }) => {
    // In the demo: t2 "Migrate /users endpoints" → t3 "Cutover and deprecation"
    const target = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const successor = page.locator('.bar', { hasText: 'Cutover' });

    const before = {
      target: await target.evaluate(el => parseFloat(el.style.left)),
      succ: await successor.evaluate(el => parseFloat(el.style.left)),
    };

    const box = await target.boundingBox();
    // Drag 60px right. At week zoom (12 px/day) that's 5 days.
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const after = {
      target: await target.evaluate(el => parseFloat(el.style.left)),
      succ: await successor.evaluate(el => parseFloat(el.style.left)),
    };

    // Target moved right
    expect(after.target).toBeGreaterThan(before.target);
    // Successor moved by the same delta — slack preserved
    const dTarget = after.target - before.target;
    const dSucc = after.succ - before.succ;
    expect(dSucc).toBeCloseTo(dTarget, 0);
  });

  test('cycle prevention: dragging a back-edge dependency is rejected', async ({ page }) => {
    // Demo has dep t1 "Spike on auth" → t2 "Migrate /users". Adding t2 → t1 would cycle.
    const succ = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const pred = page.locator('.bar', { hasText: 'Spike on auth changes' });

    // Hover the predecessor of the cycle so its dep-handle becomes visible.
    await succ.hover();
    const succBox = await succ.boundingBox();
    const predBox = await pred.boundingBox();

    // Mouse-down on succ's right edge (where the dep handle sits) and drag to pred's center.
    await page.mouse.move(succBox.x + succBox.width - 1, succBox.y + succBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(predBox.x + predBox.width / 2, predBox.y + predBox.height / 2, { steps: 12 });
    await page.mouse.up();

    // Error flash should appear
    await expect(page.locator('#flash-error')).toBeVisible();
    // No new dependency added — still 6
    await expect(page.locator('#data .dep')).toHaveCount(6);
  });

  test('Cmd/Ctrl+Z undoes a drag', async ({ page }) => {
    const target = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const before = await target.evaluate(el => parseFloat(el.style.left));
    const box = await target.boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const moved = await target.evaluate(el => parseFloat(el.style.left));
    expect(moved).toBeGreaterThan(before);

    // Move focus off any input/select before sending keys
    await page.locator('.corner').click();
    // Try both meta and control to be platform-agnostic
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Meta+z');

    const after = await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).evaluate(el => parseFloat(el.style.left));
    expect(Math.abs(after - before)).toBeLessThan(2);
  });

  test('zoom keys 1 and 4 toggle the active zoom button', async ({ page }) => {
    await page.locator('.corner').click();
    await page.keyboard.press('1');
    await expect(page.locator('#zoom-controls button[data-zoom="day"]')).toHaveClass(/active/);
    await page.keyboard.press('4');
    await expect(page.locator('#zoom-controls button[data-zoom="quarter"]')).toHaveClass(/active/);
  });

  test('clicking a dependency arrow and pressing Delete removes the dependency', async ({ page }) => {
    await expect(page.locator('#data .dep')).toHaveCount(6);
    // Some arrows stack at shared start points; force:true bypasses the
    // intercept check and clicks the topmost path at that location.
    await page.locator('#arrows .hit').first().click({ force: true });
    await page.keyboard.press('Delete');
    await expect(page.locator('#data .dep')).toHaveCount(5);
  });

  test('the task popover surfaces predecessor and successor dependencies', async ({ page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await expect(page.locator('#popover .deps-list')).toBeVisible();
    // Demo: t1 "Spike on auth changes" → t2 "Migrate /users" → t3 "Cutover"
    await expect(page.locator('#popover .deps-list')).toContainText('Spike on auth changes');
    await expect(page.locator('#popover .deps-list')).toContainText('Cutover');
  });

  test('clicking the × on a dep row in the popover removes that dependency', async ({ page }) => {
    await expect(page.locator('#data .dep')).toHaveCount(6);
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    // Demo task "Migrate /users" has 1 predecessor + 1 successor = 2 dep rows
    await expect(page.locator('#popover .dep-row')).toHaveCount(2);
    await page.locator('#popover .dep-row .dep-remove').first().click();
    await expect(page.locator('#data .dep')).toHaveCount(5);
  });

  test('Delete key removes a selected task bar', async ({ page }) => {
    const target = page.locator('.bar', { hasText: 'Cutover' });
    await target.click();                // click selects (and opens popover)
    await page.click('#po-done');        // dismiss popover; selection remains
    await page.locator('.corner').click(); // move focus off any input
    await page.keyboard.press('Delete');
    await expect(page.locator('.bar', { hasText: 'Cutover' })).toHaveCount(0);
    await expect(page.locator('.bar')).toHaveCount(7);
  });

  test('+ Project adds a new project row and opens the project popover', async ({ page }) => {
    const before = await page.locator('.left-cell.proj').count();
    await page.click('#add-project-btn');
    await expect(page.locator('#project-popover')).toBeVisible();
    await page.click('#pp-done');
    await expect(page.locator('.left-cell.proj')).toHaveCount(before + 1);
  });

  test('clicking the autosave banner re-uses a remembered handle (no file picker)', async ({ page }) => {
    // Simulate a reload after autosave was previously enabled: a handle is
    // remembered from IDB but permission has lapsed (queryPermission='prompt').
    // The banner-click should call requestPermission on the remembered handle,
    // not call showOpenFilePicker.
    await page.evaluate(() => {
      window.__pickerCalls = 0;
      window.__requestPermCalls = 0;
      window.showOpenFilePicker = async () => {
        window.__pickerCalls++;
        throw new Error('showOpenFilePicker should not have been called');
      };
      const fake = {
        kind: 'file',
        name: 'nano-pm.html',
        queryPermission: async () => 'prompt',
        requestPermission: async () => { window.__requestPermCalls++; return 'granted'; },
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      };
      window.__nanopm_test.setRememberedHandle(fake);
      window.__nanopm_test.refreshSavePath();
    });

    await expect(page.locator('#autosave-banner')).toBeVisible();
    // Banner copy should reflect the "re-enable" state (mention the filename).
    await expect(page.locator('#autosave-banner')).toContainText(/re-enable|nano-pm\.html/i);

    await page.click('#enable-autosave');
    await page.waitForFunction(() => window.__requestPermCalls > 0);

    expect(await page.evaluate(() => window.__pickerCalls)).toBe(0);
    expect(await page.evaluate(() => window.__requestPermCalls)).toBe(1);
    await expect(page.locator('#autosave-banner')).toBeHidden();
  });

  test('re-enabling autosave actually writes to the handle and updates save status', async ({ page }) => {
    // Inject a fake remembered handle that records every write.
    await page.evaluate(() => {
      window.__writes = [];
      const fake = {
        kind: 'file',
        name: 'nano-pm.html',
        queryPermission: async () => 'prompt',
        requestPermission: async () => 'granted',
        createWritable: async () => ({
          write: async (data) => { window.__writes.push(String(data).length); },
          close: async () => {},
        }),
      };
      window.__nanopm_test.setRememberedHandle(fake);
      window.__nanopm_test.refreshSavePath();
    });

    await page.click('#enable-autosave');
    // Wait for the immediate post-enable save to land.
    await page.waitForFunction(() => window.__writes.length > 0);

    // Save status should now read "Saved at …" (not the dirty state, not empty).
    await expect(page.locator('#save-status')).toContainText(/Saved at/);

    // Now make an edit and verify it triggers a debounced save (≤ ~700ms).
    const target = page.locator('.bar', { hasText: 'Cutover' });
    const box = await target.boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    await page.waitForFunction(() => window.__writes.length >= 2, null, { timeout: 2000 });
    // The latest write should still be a full HTML doc (length much larger than the data block alone).
    const sizes = await page.evaluate(() => window.__writes);
    expect(sizes[sizes.length - 1]).toBeGreaterThan(10000);
  });

  test('clicking the Save button forces an immediate save and flashes success', async ({ page }) => {
    await page.evaluate(() => {
      window.__writes = [];
      const fake = {
        kind: 'file',
        name: 'nano-pm.html',
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        createWritable: async () => ({
          write: async (d) => { window.__writes.push(String(d).length); },
          close: async () => {},
        }),
      };
      window.__nanopm_test.setSaveHandle(fake);
      window.__nanopm_test.refreshSavePath();
    });

    // Save button must be visible and clickable, even in FS-API/autosave mode.
    await expect(page.locator('#save-btn')).toBeVisible();
    await page.click('#save-btn');
    await page.waitForFunction(() => window.__writes.length > 0);

    await expect(page.locator('#flash-success')).toBeVisible();
    await expect(page.locator('#flash-success')).toContainText(/Saved/);
  });

  test('autosave does not clobber an open popover mid-edit', async ({ page }) => {
    await page.evaluate(() => {
      window.__writes = [];
      const fake = {
        kind: 'file',
        name: 'nano-pm.html',
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        createWritable: async () => ({
          write: async (d) => { window.__writes.push(String(d).length); },
          close: async () => {},
        }),
      };
      window.__nanopm_test.setSaveHandle(fake);
    });

    const bar = page.locator('.bar', { hasText: 'Cutover' });
    await bar.click();
    await expect(page.locator('#popover')).toBeVisible();
    const title = page.locator('#po-title');
    await title.fill('Cutover (edited)');
    await title.dispatchEvent('change');

    // Debounced save (500ms) should fire while the popover is still open.
    await page.waitForFunction(() => window.__writes.length > 0, null, { timeout: 2000 });

    // The popover must still be open with its content intact — the user is
    // still editing.
    await expect(page.locator('#popover')).toBeVisible();
    await expect(page.locator('#po-title')).toHaveValue('Cutover (edited)');
  });

  test('an edit flips the save status to dirty and writes a localStorage backup', async ({ page }) => {
    const target = page.locator('.bar', { hasText: 'Cutover' });
    const box = await target.boundingBox();
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();

    await expect(page.locator('#save-status')).toHaveClass(/dirty/);

    // The debounced save (500ms) writes the localStorage backup mirror.
    await page.waitForFunction(() => !!localStorage.getItem('nano-pm:backup'), null, { timeout: 2000 });
    const backup = await page.evaluate(() => localStorage.getItem('nano-pm:backup'));
    expect(backup).toBeTruthy();
  });
});
