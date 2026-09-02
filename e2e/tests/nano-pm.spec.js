const http = require('http');

const { test, expect, login, reset } = require('./fixtures');

function germanDate(iso, withArticle = false) {
  const months = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
  ];
  const [year, month, day] = iso.split('-').map(Number);
  return `${withArticle ? 'den ' : ''}${day}. ${months[month - 1]} ${year}`;
}

function germanDateShift(beforeIso, afterIso) {
  const before = new Date(`${beforeIso}T00:00:00Z`);
  const after = new Date(`${afterIso}T00:00:00Z`);
  const deltaDays = Math.round((after - before) / (24 * 60 * 60 * 1000));
  const absDays = Math.abs(deltaDays);
  let amount;
  if (absDays % 7 === 0) {
    const weeks = absDays / 7;
    amount = weeks === 1 ? 'eine Woche' : `${weeks} Wochen`;
  } else {
    amount = absDays === 1 ? 'einen Tag' : `${absDays} Tage`;
  }
  return `um ${amount} ${deltaDays > 0 ? 'nach hinten' : 'nach vorne'} auf ${germanDate(afterIso, true)}`;
}

async function placeMilestoneGhost(page, project, offset = 140) {
  const row = project.locator('.chart-row.proj');
  await expect(row.locator('.creation-milestone-preview')).toBeVisible();
  const rowBox = await row.boundingBox();
  const sidebar = await project.locator('.left-cell.proj').boundingBox();
  await page.mouse.click(sidebar.x + sidebar.width + offset, rowBox.y + rowBox.height / 2);
  await expect(page.locator('#milestone-popover')).toBeVisible();
}

async function startWebhookServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let json = null;
      try { json = JSON.parse(body || '{}'); } catch (_) {}
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, json });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/teams-webhook`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

// =============================================================================
// Auth + first render
// =============================================================================
test.describe('auth + page render', () => {
  test('login page renders the form', async ({ page, request }) => {
    await reset(request);
    await page.goto('/accounts/login/');
    await expect(page.locator('.login-card .fieldset-legend')).toHaveText('Login');
    await expect(page.locator('input[name=username]')).toBeVisible();
    await expect(page.locator('input[name=password]')).toBeVisible();
  });

  test('login inputs use readable text size', async ({ page, request }) => {
    await reset(request);
    await page.goto('/accounts/login/');

    for (const name of ['username', 'password']) {
      await expect(page.locator(`input[name=${name}]`)).toHaveCSS('font-size', '16px');
    }
  });

  test('login form uses daisyUI fieldset labels', async ({ page, request }) => {
    await reset(request);
    await page.goto('/accounts/login/');

    await expect(page.locator('.login-card fieldset.fieldset')).toHaveClass(/\bbg-base-200\b/);
    await expect(page.locator('.login-card .fieldset-legend')).toHaveText('Login');
    await expect(page.locator('.login-card label.label')).toHaveText(['Username', 'Password']);
    await expect(page.locator('input[name=username]')).toHaveClass(/\binput\b/);
    await expect(page.locator('input[name=password]')).toHaveClass(/\binput\b/);
  });

  test('an unauthenticated request to / redirects to login', async ({ page, request }) => {
    await reset(request);
    const r = await page.goto('/');
    expect(r.url()).toContain('/accounts/login/');
  });

  test('demo / demo logs in and lands on the chart', async ({ page, request }) => {
    await reset(request);
    await login(page);
    await expect(page.locator('.sidebar-brand')).toHaveText('nano-pm');
    await expect(page.locator('#grid-scroll')).toBeVisible();
  });

  test('theme toggle switches to dark mode and persists', async ({ appPage: page }) => {
    await page.evaluate(() => localStorage.removeItem('nano-theme'));
    await page.reload();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('session sidebar width is server-rendered before app JS loads', async ({ page, request }) => {
    await reset(request);
    await login(page);
    await page.evaluate(async () => {
      const csrf = document.querySelector('meta[name="csrf-token"]').content;
      await fetch('/ui/sidebar-width/', {
        method: 'POST',
        headers: { 'X-CSRFToken': csrf, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'width=320',
      });
    });

    await page.route('**/static/js/nano.js', route => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '',
    }));

    await page.goto('/');
    await expect(page.locator('#grid')).toBeVisible();

    const layout = await page.evaluate(() => {
      const htmlStyle = getComputedStyle(document.documentElement);
      const cell = document.querySelector('.left-cell').getBoundingClientRect();
      const gridStyle = getComputedStyle(document.getElementById('grid'));
      return {
        leftW: parseFloat(htmlStyle.getPropertyValue('--left-w')),
        cellWidth: cell.width,
        gridTemplateColumns: gridStyle.gridTemplateColumns,
      };
    });

    expect(layout.leftW).toBe(320);
    expect(layout.cellWidth).toBe(320);
    expect(layout.gridTemplateColumns).toContain('320px');
  });
});

// =============================================================================
// Activity log
// =============================================================================
test.describe('activity log', () => {
  test('task changes are recorded with actor and old/new values', async ({ appPage: page }) => {
    await page.getByRole('link', { name: 'Activity' }).click();
    await expect(page).toHaveURL('/activity/');
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await expect(page.locator('.activity-event', { hasText: 'Migrate users (activity)' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).click();
    await expect(page.locator('#task-popover')).toBeVisible();
    await page.fill('#task-popover input[name=title]', 'Migrate users (activity)');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('#task-popover')).toHaveCount(0);

    await page.getByRole('link', { name: 'Activity' }).click();
    const event = page.locator('.activity-event').first();
    await expect(event.locator('td').nth(1)).toHaveText('demo');
    await expect(event).toContainText('updated task Migrate users (activity)');
    await expect(event).toContainText('Title');
    await expect(event).toContainText('Migrate /users endpoints → Migrate users (activity)');
  });

  test('list-like task changes render as plain comma-separated values', async ({ appPage: page }) => {
    await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).click();
    await expect(page.locator('#task-popover')).toBeVisible();

    const alexValue = await page.locator('#task-assignees option', { hasText: 'Alex Chen' }).first().getAttribute('value');
    await page.locator('#task-assignees').selectOption([alexValue]);
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('#task-popover')).toHaveCount(0);

    await page.getByRole('link', { name: 'Activity' }).click();
    const event = page.locator('.activity-event').first();
    await expect(event).toContainText('Assignees');
    await expect(event).toContainText('Alex Chen, Sam Patel → Alex Chen');
    await expect(event).not.toContainText("['Alex Chen', 'Sam Patel']");
  });

  test('activity event text is translated to German', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const taskId = await bar.getAttribute('data-task-id');
    const currentEnd = await bar.getAttribute('data-end');
    const nextEnd = await page.evaluate((iso) => {
      const date = new Date(`${iso}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + 1);
      return date.toISOString().slice(0, 10);
    }, currentEnd);

    const status = await page.evaluate(async ({ taskId, nextEnd }) => {
      const token = document.cookie.split('; ').find((row) => row.startsWith('csrftoken='))?.split('=')[1] || '';
      const response = await fetch(`/tasks/${taskId}/resize/end/`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRFToken': decodeURIComponent(token), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ end: nextEnd }),
      });
      return response.status;
    }, { taskId, nextEnd });
    expect(status).toBe(200);

    await page.getByRole('link', { name: 'Activity' }).click();
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    const event = page.locator('.activity-event').first();
    await expect(page.getByRole('heading', { name: 'Aktivität' })).toBeVisible();
    await expect(event.locator('td').nth(1)).toHaveText('demo');
    await expect(event).toContainText('Dauer der Aufgabe Migrate /users endpoints geändert');
    await expect(event).toContainText('Ende');
  });
});

// =============================================================================
// Ideas
// =============================================================================
test.describe('ideas', () => {
  async function loginAs(page, username, password = username) {
    await page.goto('/accounts/login/');
    await page.fill('input[name=username]', username);
    await page.fill('input[name=password]', password);
    await page.click('button[type=submit]');
    await page.waitForURL('/');
  }

  test('ideas can be captured, edited in a full-page detail view, and promoted', async ({ appPage: page }) => {
    await page.getByRole('link', { name: 'Ideas' }).click();
    await expect(page).toHaveURL('/ideas/');
    await expect(page.getByRole('heading', { name: 'Ideas' })).toBeVisible();

    await page.getByPlaceholder('Sketch a new idea…').fill('Client-facing timeline');
    await page.getByRole('button', { name: 'Add idea' }).click();
    await expect(page).toHaveURL(/\/ideas\/\d+\/$/);

    await page.waitForFunction(() => window.nanoIdeaEditor);
    const textarea = page.locator('textarea[name="body"]');
    await expect(textarea).toHaveAttribute('rows', '24');
    await expect(page.locator('.EasyMDEContainer')).toBeVisible();
    await expect(page.locator('.editor-toolbar button.image')).toHaveCount(0);
    await expect(page.locator('.editor-toolbar button.table')).toHaveCount(0);

    await page.locator('select[name="status"]').selectOption('exploring');
    await page.locator('input[name="tags"]').fill('client, roadmap');
    await page.evaluate(() => {
      window.nanoIdeaEditor.setMarkdown('# Goal\n\nLet customers see a simplified schedule.');
    });
    await page.getByRole('button', { name: 'Save idea' }).click();

    await expect(page.locator('.idea-flash')).toContainText('Idea saved');
    await expect(page.locator('select[name="status"]')).toHaveValue('exploring');
    await page.waitForFunction(() => window.nanoIdeaEditor);
    await expect(textarea).toHaveValue(/simplified schedule/);
    await expect.poll(() => page.evaluate(() => window.nanoIdeaEditor.getMarkdown())).toContain('simplified schedule');

    await page.getByRole('button', { name: 'Convert to project' }).click();
    await expect(page.locator('.idea-conversion')).toContainText('Converted to project');

    await page.getByRole('link', { name: 'Projects' }).click();
    await expect(page.locator('.left-cell.proj', { hasText: 'Client-facing timeline' })).toBeVisible();
  });

  test('EasyMDE full-screen modes cover the app sidebar', async ({ appPage: page }) => {
    await page.goto('/ideas/');
    await page.getByPlaceholder('Sketch a new idea…').fill('Fullscreen editor idea');
    await page.getByRole('button', { name: 'Add idea' }).click();
    await expect(page).toHaveURL(/\/ideas\/\d+\/$/);
    await page.waitForFunction(() => window.nanoIdeaEditor);

    const coverageAtSidebar = () => page.evaluate(() => ({
      toolbar: Boolean(document.elementFromPoint(16, 16)?.closest('.editor-toolbar.fullscreen')),
      editor: Boolean(document.elementFromPoint(16, 80)?.closest('.CodeMirror-fullscreen')),
    }));

    await page.locator('.editor-toolbar button.fullscreen').click();
    await expect(page.locator('.editor-toolbar.fullscreen')).toBeVisible();
    expect(await coverageAtSidebar()).toEqual({ toolbar: true, editor: true });

    await page.locator('.editor-toolbar button.fullscreen').click();
    await expect(page.locator('.editor-toolbar.fullscreen')).toHaveCount(0);

    await page.locator('.editor-toolbar button.side-by-side').click();
    await expect(page.locator('.editor-preview-active-side')).toBeVisible();
    expect(await coverageAtSidebar()).toEqual({ toolbar: true, editor: true });
  });

  test('idea cards do not show body previews', async ({ appPage: page }) => {
    await page.goto('/ideas/');
    await page.getByPlaceholder('Sketch a new idea…').fill('HTML preview idea');
    await page.getByRole('button', { name: 'Add idea' }).click();
    await expect(page).toHaveURL(/\/ideas\/\d+\/$/);
    const ideaId = page.url().match(/\/ideas\/(\d+)\//)[1];

    await page.evaluate(async (id) => {
      const token = document.cookie.split('; ').find((row) => row.startsWith('csrftoken='))?.split('=')[1] || '';
      await fetch(`/ideas/${id}/update/`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRFToken': decodeURIComponent(token), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          title: 'HTML preview idea',
          body: '<p>Customer <strong>research</strong> notes</p>',
          status: 'inbox',
          tags: '',
        }),
      });
    }, ideaId);

    await page.goto('/ideas/');
    const card = page.locator('.idea-card', { hasText: 'HTML preview idea' });
    await expect(card).toBeVisible();
    await expect(card).not.toContainText('Customer research notes');
    await expect(card).not.toContainText('<p>');
    await expect(card).not.toContainText('<strong>');
  });

  test('idea CRUD uses Django model permissions, with PMs as workspace admins', async ({ page, request }) => {
    await reset(request);
    await loginAs(page, 'member1');
    await expect(page.getByRole('link', { name: 'Ideas' })).toHaveCount(0);
    const deniedList = await page.goto('/ideas/');
    expect(deniedList.status()).toBe(403);

    await loginAs(page, 'ideaeditor');
    await expect(page.getByRole('link', { name: 'Ideas' })).toBeVisible();
    await page.getByRole('link', { name: 'Ideas' }).click();
    await page.getByPlaceholder('Sketch a new idea…').fill('Permissioned idea');
    await page.getByRole('button', { name: 'Add idea' }).click();
    await expect(page).toHaveURL(/\/ideas\/\d+\/$/);
    const ideaUrl = page.url();
    const ideaId = ideaUrl.match(/\/ideas\/(\d+)\//)[1];

    await page.waitForFunction(() => window.nanoIdeaEditor);
    await expect(page.getByRole('button', { name: 'Save idea' })).toBeVisible();
    await page.locator('.idea-title-input').fill('Permissioned idea updated');
    await page.getByRole('button', { name: 'Save idea' }).click();
    await expect(page.locator('.idea-flash')).toContainText('Idea saved');

    const allowed = await page.evaluate(async (id) => {
      const token = document.cookie.split('; ').find((row) => row.startsWith('csrftoken='))?.split('=')[1] || '';
      const response = await fetch(`/ideas/${id}/update/`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRFToken': decodeURIComponent(token), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'title=Permission+updated+via+fetch&body=Allowed&status=exploring&tags=permitted',
      });
      return response.status;
    }, ideaId);
    expect(allowed).toBe(200);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await login(page);
    await page.goto(ideaUrl);
    await expect(page.getByRole('button', { name: 'Save idea' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete idea' })).toBeVisible();
    await page.locator('.idea-title-input').fill('PM updated permissioned idea');
    await page.getByRole('button', { name: 'Save idea' }).click();
    await expect(page.locator('.idea-flash')).toContainText('Idea saved');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await loginAs(page, 'member1');
    const deniedUpdate = await page.evaluate(async (id) => {
      const token = document.cookie.split('; ').find((row) => row.startsWith('csrftoken='))?.split('=')[1] || '';
      const response = await fetch(`/ideas/${id}/update/`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRFToken': decodeURIComponent(token), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'title=Denied&body=Nope&status=exploring&tags=',
      });
      return response.status;
    }, ideaId);
    expect(deniedUpdate).toBe(403);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await loginAs(page, 'ideaeditor');
    await page.goto(ideaUrl);
    let sawCancelDialog = false;
    page.once('dialog', async dialog => {
      sawCancelDialog = true;
      expect(dialog.message()).toContain('Delete idea');
      await dialog.dismiss();
    });
    await page.getByRole('button', { name: 'Delete idea' }).click();
    expect(sawCancelDialog).toBe(true);
    await expect(page).toHaveURL(ideaUrl);
    await expect(page.getByRole('button', { name: 'Delete idea' })).toBeVisible();

    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Delete idea');
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'Delete idea' }).click();
    await expect(page).toHaveURL('/ideas/');
    await expect(page.locator('.idea-card', { hasText: 'PM updated permissioned idea' })).toHaveCount(0);
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
    await expect(page.locator('#zoom-controls')).toHaveCount(0);
    await expect(page.locator('button:has-text("Today")')).toBeVisible();
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

  test('project groups use subtle header accents without tinting task rows', async ({ appPage: page }) => {
    const styles = await page.evaluate(() => {
      const project = document.querySelector('.left-cell.proj');
      const projectId = project.dataset.projectId;
      const task = document.querySelector(`.left-cell.task[data-project-id="${projectId}"]`);
      const projectTimeline = document.querySelector(`.chart-row.proj[data-project-id="${projectId}"]`);
      const taskTimeline = document.querySelector(`.chart-row[data-task-id][data-project-id="${projectId}"]`);
      const baseLeft = getComputedStyle(document.querySelector('.corner')).backgroundColor;
      const baseTimeline = getComputedStyle(document.querySelector('.chart-row.add-project-spacer')).backgroundColor;
      return {
        projectColor: getComputedStyle(project).getPropertyValue('--project-color').trim(),
        taskProjectColor: getComputedStyle(task).getPropertyValue('--project-color').trim(),
        railWidth: parseFloat(getComputedStyle(project, '::before').width),
        taskRailWidth: parseFloat(getComputedStyle(task, '::before').width),
        projectBackground: getComputedStyle(project).backgroundColor,
        taskBackground: getComputedStyle(task).backgroundColor,
        projectTimelineBackground: getComputedStyle(projectTimeline).backgroundColor,
        taskTimelineBackground: getComputedStyle(taskTimeline).backgroundColor,
        swatchBg: getComputedStyle(project.querySelector('.swatch')).backgroundColor,
        baseLeft,
        baseTimeline,
      };
    });

    expect(styles.projectColor).toBe('#3b82f6');
    expect(styles.taskProjectColor).toBe(styles.projectColor);
    expect(styles.railWidth).toBe(4);
    expect(styles.taskRailWidth).toBeLessThanOrEqual(2);
    expect(styles.projectBackground).not.toBe(styles.baseLeft);
    expect(styles.projectTimelineBackground).not.toBe(styles.baseTimeline);
    expect(styles.taskBackground).toBe(styles.baseLeft);
    expect(styles.taskTimelineBackground).toBe(styles.baseTimeline);
    expect(styles.swatchBg).toBe('rgb(59, 130, 246)');
  });

  test('team filter limits project view to tasks assigned to selected teams', async ({ appPage: page }) => {
    await page.locator('#team-filter summary').click();
    await page.locator('#team-filter .team-filter-option', { hasText: 'Design' }).click();

    await expect(page.locator('#team-filter summary')).toContainText('Teams (1)');
    await expect(page.locator('#team-filter .team-filter-option.active', { hasText: 'Design' })).toHaveCount(1);
    await expect(page.locator('.left-cell.proj')).toHaveCount(2);
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toHaveCount(0);
    await expect(page.locator('.left-cell.proj', { hasText: 'Onboarding revamp' })).toBeVisible();
    await expect(page.locator('.left-cell.proj', { hasText: 'Infra hardening' })).toBeVisible();
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(4);
    await expect(page.locator('#arrows .hit')).toHaveCount(2);

    await page.locator('#team-filter summary').click();
    await page.locator('#team-filter .team-filter-option', { hasText: 'Design' }).click();
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(8);
  });

  test('creating a project under a team filter warns that it is hidden and can clear the filter', async ({ appPage: page }) => {
    await page.locator('#team-filter summary').click();
    await page.locator('#team-filter .team-filter-option', { hasText: 'Design' }).click();
    await expect(page.locator('.left-cell.proj')).toHaveCount(2);

    await page.locator('.add-project-row').last().click();

    const toast = page.locator('#toast-slot .team-filter-project-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Project created, but it’s hidden by the active team filter.');
    await expect(toast).toHaveCSS('background-color', 'rgb(26, 26, 26)');
    await expect(toast).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(page.locator('#team-filter summary')).toContainText('Teams (1)');
    await expect(page.locator('.left-cell.proj')).toHaveCount(2);

    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast).toHaveCount(0);
    await expect(page.locator('#team-filter summary')).toContainText('Teams (1)');

    await page.locator('.add-project-row').last().click();
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Clear team filter' }).click();
    await expect(page.locator('#team-filter summary')).toHaveText('Teams');
    await expect(page.locator('.left-cell.proj')).toHaveCount(5);
    await expect(page.locator('.left-cell.proj', { hasText: 'New project' })).toHaveCount(2);
    await expect(page.locator('#toast-slot .nano-toast')).toHaveCount(0);
  });

  test('every dep arrow terminates on its target bar (y-aligned)', async ({ appPage: page }) => {
    // Each .hit path ends at the LEFT edge of its successor bar. The end-y of
    // the path (last L command) must land inside the target bar's vertical
    // bounds, otherwise the arrow points to empty space — the regression we
    // saw when the add-project-spacer row offset everything by row_h.
    const info = await page.evaluate(() => {
      const grid = document.getElementById('grid-scroll');
      const gridRect = grid.getBoundingClientRect();
      const arrowsRect = document.getElementById('arrows').getBoundingClientRect();
      // Overlay is offset from grid by axis_h + left_w; convert SVG-y to grid-y
      // by adding the SVG's top relative to the grid.
      const yOffset = arrowsRect.top - gridRect.top + grid.scrollTop;
      const results = [];
      for (const hit of document.querySelectorAll('#arrows .hit[data-dep]')) {
        const d = hit.getAttribute('d') || '';
        // Last L command pair gives the arrow tip — "L tx ty" at end of path.
        const m = d.match(/L\s+([\d.\-]+)\s+([\d.\-]+)\s*$/);
        if (!m) continue;
        const tipY = parseFloat(m[2]) + yOffset;
        const [, toId] = hit.dataset.dep.split('-');
        const bar = document.querySelector(`.bar[data-task-id="${toId}"], [id="bar-${toId}"]`);
        if (!bar) continue;
        const br = bar.getBoundingClientRect();
        const barCenterY = (br.top + br.bottom) / 2 - gridRect.top + grid.scrollTop;
        results.push({ dep: hit.dataset.dep, tipY, barTop: br.top - gridRect.top + grid.scrollTop,
                       barBottom: br.bottom - gridRect.top + grid.scrollTop, barCenterY });
      }
      return results;
    });
    expect(info.length).toBeGreaterThan(0);
    for (const r of info) {
      expect(r.tipY, `dep ${r.dep} tip-y=${r.tipY} outside bar [${r.barTop},${r.barBottom}]`)
        .toBeGreaterThanOrEqual(r.barTop - 1);
      expect(r.tipY, `dep ${r.dep} tip-y=${r.tipY} outside bar [${r.barTop},${r.barBottom}]`)
        .toBeLessThanOrEqual(r.barBottom + 1);
    }
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

  test('dragging empty timeline space pans the chart with grab cursors', async ({ appPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 360 });
    const blankRow = page.locator('.chart-row.add-project-spacer').last();
    await blankRow.scrollIntoViewIfNeeded();
    await expect(blankRow).toHaveCSS('cursor', 'grab');

    const start = await page.evaluate(() => {
      const sc = document.getElementById('grid-scroll');
      const maxLeft = sc.scrollWidth - sc.clientWidth;
      sc.scrollLeft = Math.min(maxLeft - 150, Math.max(150, maxLeft / 2));
      sc.scrollTop = sc.scrollHeight - sc.clientHeight;
      return { left: sc.scrollLeft, top: sc.scrollTop };
    });
    expect(start.left).toBeGreaterThan(100);
    expect(start.top).toBeGreaterThan(50);

    const scBox = await page.locator('#grid-scroll').boundingBox();
    const rowBox = await blankRow.boundingBox();
    const x = scBox.x + scBox.width - 80;
    const y = rowBox.y + rowBox.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(blankRow).toHaveCSS('cursor', 'grabbing');
    await page.mouse.move(x - 100, y + 50, { steps: 8 });

    const moved = await page.evaluate(() => {
      const sc = document.getElementById('grid-scroll');
      return { left: sc.scrollLeft, top: sc.scrollTop };
    });
    expect(moved.left).toBeGreaterThan(start.left + 90);
    expect(moved.top).toBeLessThan(start.top - 40);

    await page.mouse.up();
    await expect(blankRow).toHaveCSS('cursor', 'grab');
  });

  test('the sidebar (sticky-left column) stays visible at any horizontal scroll position', async ({ appPage: page }) => {
    // Scroll all the way to the right edge of the chart.
    await page.evaluate(() => {
      const sc = document.getElementById('grid-scroll');
      sc.scrollLeft = sc.scrollWidth - sc.clientWidth;
    });
    // The first sticky-left cell should still be anchored at the left edge
    // of the drawer-content area (offset by the 220px app sidebar).
    const cell = page.locator('.left-cell').first();
    const box = await cell.boundingBox();
    const sidebarW = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-sidebar-w')) || 0
    );
    expect(box.x).toBeGreaterThan(sidebarW - 2);
    expect(box.x).toBeLessThan(sidebarW + 4);
  });

  test('the sidebar width can be resized by dragging the resizer handle', async ({ appPage: page }) => {
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

  test('the sidebar width persists across reloads (session)', async ({ appPage: page }) => {
    const resizer = page.locator('#sidebar-resizer');
    const box = await resizer.boundingBox();
    const startX = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const saved = page.waitForResponse(response =>
      response.url().includes('/ui/sidebar-width/') && response.status() === 204
    );
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 60, y, { steps: 10 });
    await page.mouse.up();
    await saved;

    await page.route('**/static/js/nano.js', route => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '',
    }));
    await page.reload();
    const w = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'))
    );
    expect(w).toBe(300);
  });

  test('the sidebar resize handle clamps to a minimum width', async ({ appPage: page }) => {
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

  test('today line follows the current time within the day', async ({ appPage: page }) => {
    await expect(page.locator('#today-line')).toBeVisible();

    const offsetWithinDay = await page.evaluate(() => {
      const line = document.getElementById('today-line');
      const ppd = parseFloat(document.getElementById('grid-scroll').dataset.pxPerDay);
      const x = parseFloat(line.style.left);
      return x - Math.floor(x / ppd) * ppd;
    });

    expect(offsetWithinDay).toBeGreaterThan(0.01);
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

  test('dependency arrows paint above project-header rows (cross-project deps stay visible)', async ({ appPage: page }) => {
    // chart-row.proj has its own gray background and a z-index; if the
    // arrows overlay sits below that z-index, any arrow whose route passes
    // through a project header row vanishes behind the gray bg.
    const overlayZ = await page.locator('#overlay').evaluate(
      el => parseInt(getComputedStyle(el).zIndex, 10) || 0
    );
    const projRowZ = await page.locator('.chart-row.proj').first().evaluate(
      el => parseInt(getComputedStyle(el).zIndex, 10) || 0
    );
    expect(overlayZ).toBeGreaterThanOrEqual(projRowZ);
  });

  test('the sticky sidebar paints above the arrows/today overlay', async ({ appPage: page }) => {
    // Counterpart to the test above: overlay needs to sit *above* the
    // chart-row backgrounds but *below* the sticky-left sidebar, otherwise
    // the SVG arrows (overflow:visible) and today-line bleed over the
    // sidebar when the chart is scrolled horizontally.
    const overlayZ = await page.locator('#overlay').evaluate(
      el => parseInt(getComputedStyle(el).zIndex, 10) || 0
    );
    const taskCellZ = await page.locator('.left-cell.task').first().evaluate(
      el => parseInt(getComputedStyle(el).zIndex, 10) || 0
    );
    const projCellZ = await page.locator('.left-cell.proj').first().evaluate(
      el => parseInt(getComputedStyle(el).zIndex, 10) || 0
    );
    expect(taskCellZ).toBeGreaterThan(overlayZ);
    expect(projCellZ).toBeGreaterThan(overlayZ);
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

  test('day zoom uses year, month, week, and day axis rows with workdays distinct', async ({ appPage: page }) => {
    await page.goto('/?zoom=day');
    await expect(page.locator('#time-axis.day-axis')).toBeVisible();
    await expect(page.locator('#time-axis .axis-year').first()).toBeVisible();
    await expect(page.locator('#time-axis .axis-month').first()).toBeVisible();
    await expect(page.locator('#time-axis .axis-week').first()).toBeVisible();
    await expect(page.locator('#time-axis .axis-day').first()).toBeVisible();

    const classes = await page.locator('#time-axis .axis-day').evaluateAll(days => ({
      workdays: days.filter(day => !day.classList.contains('weekend')).length,
      weekends: days.filter(day => day.classList.contains('weekend')).length,
      twoLineLabels: days.every(day => day.querySelector('.axis-day-name') && day.querySelector('.axis-day-number')),
      dayNames: days.map(day => day.querySelector('.axis-day-name')?.textContent?.trim()),
    }));
    expect(classes.workdays).toBeGreaterThan(0);
    expect(classes.weekends).toBeGreaterThan(0);
    expect(classes.twoLineLabels).toBe(true);
    expect(classes.dayNames).toEqual(expect.arrayContaining(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']));
  });

  test('legacy zoom URLs still render at day density without zoom buttons', async ({ appPage: page }) => {
    await expect(page.locator('#zoom-controls')).toHaveCount(0);
    expect(await page.locator('#grid-scroll').evaluate(
      el => parseFloat(el.dataset.pxPerDay)
    )).toBe(36);

    await page.goto('/?zoom=week');
    await expect(page.locator('#zoom-controls')).toHaveCount(0);
    expect(await page.locator('#grid-scroll').evaluate(
      el => parseFloat(el.dataset.pxPerDay)
    )).toBe(36);
  });

  test('the px-per-day slider adjusts the day chart density', async ({ appPage: page }) => {
    expect(await page.locator('#grid-scroll').evaluate(
      el => parseFloat(el.dataset.pxPerDay)
    )).toBe(36);

    const slider = page.locator('#zoom-slider');
    await expect(slider).toBeVisible();
    expect(await slider.getAttribute('min')).toBe('18');
    expect(await slider.getAttribute('max')).toBe('72');
    expect(await slider.getAttribute('step')).toBe('1');

    // Drag slider to its max and let the SSE patch land.
    await slider.evaluate(el => {
      el.value = el.max;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => parseFloat(document.getElementById('grid-scroll').dataset.pxPerDay) === 72,
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

  test('the slider remembers the day density across legacy zoom URLs', async ({ appPage: page }) => {
    await page.locator('#zoom-slider').evaluate(el => {
      el.value = el.max;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => parseFloat(document.getElementById('grid-scroll').dataset.pxPerDay) === 72,
      null, { timeout: 5000 }
    );

    await page.goto('/?zoom=week');
    await expect(page.locator('#zoom-controls')).toHaveCount(0);
    expect(await page.locator('#zoom-slider').inputValue()).toBe('72');
    expect(await page.locator('#grid-scroll').evaluate(
      el => parseFloat(el.dataset.pxPerDay)
    )).toBe(72);
  });
});

// =============================================================================
// Project collapse (client-side via Datastar signals)
// =============================================================================
test.describe('project collapse', () => {
  test('clicking the chevron on a project header hides its task rows', async ({ appPage: page }) => {
    // Seed: 8 task rows total. "API Migration" owns 3 of them.
    // All rows are always in the DOM; collapsed rows get display:none.
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(8);

    const header = page.locator('.left-cell.proj', { hasText: 'API Migration' });
    await header.locator('.collapse-toggle').click();

    // Client-side toggle is instant — no SSE round-trip.
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(5);

    // Header itself stays visible.
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toBeVisible();

    // The popover should NOT have opened — clicking the chevron is a different
    // gesture from clicking the header label.
    await expect(page.locator('#project-popover')).toHaveCount(0);
  });

  test('clicking the chevron again expands the project', async ({ appPage: page }) => {
    const header = page.locator('.left-cell.proj', { hasText: 'API Migration' });
    await header.locator('.collapse-toggle').click();
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(5);

    await page.locator('.left-cell.proj', { hasText: 'API Migration' })
      .locator('.collapse-toggle').click();
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(8);
  });

  test('clicking the project header label still opens the edit popover', async ({ appPage: page }) => {
    // The chevron must not steal clicks from the rest of the row — the existing
    // "click row to edit" gesture still has to work.
    const header = page.locator('.left-cell.proj', { hasText: 'API Migration' });
    await header.locator('.name').click();
    await expect(page.locator('#project-popover')).toBeVisible();
  });

  test('arrows touching a collapsed project are hidden', async ({ appPage: page }) => {
    // Seed has 6 dep arrows; collapsing API Migration hides arrows whose
    // endpoints are in the collapsed project.
    await expect(page.locator('#arrows .hit:visible')).toHaveCount(6);

    const header = page.locator('.left-cell.proj', { hasText: 'API Migration' });
    await header.locator('.collapse-toggle').click();
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(5);

    const afterArrows = await page.locator('#arrows .hit:visible').count();
    expect(afterArrows).toBeLessThan(6);
  });

  test('collapse-all button hides all task rows, then expand-all restores them', async ({ appPage: page }) => {
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(8);

    const btn = page.locator('#collapse-all-btn');
    await expect(btn).toHaveText('Collapse all');
    await btn.click();

    await expect(page.locator('.left-cell.task:visible')).toHaveCount(0);
    await expect(btn).toHaveText('Expand all');

    await btn.click();
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(8);
    await expect(btn).toHaveText('Collapse all');
  });
});


// =============================================================================
// Project sorting
// =============================================================================
test.describe('project sorting', () => {
  test('sorting controls stay inside the project sidebar at its minimum width', async ({ appPage: page }) => {
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    await expect(page.locator('#collapse-all-btn > span')).toHaveText('Alle einklappen');
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--left-w', '140px');
    });

    const bounds = await page.evaluate(() => {
      const corner = document.querySelector('.corner').getBoundingClientRect();
      const sort = document.getElementById('project-sort-toggle').getBoundingClientRect();
      const collapseLabel = document.querySelector('#collapse-all-btn > span');
      return {
        cornerRight: corner.right,
        sortRight: sort.right,
        collapseLabelOverflow: getComputedStyle(collapseLabel).textOverflow,
        collapseLabelIsClipped: collapseLabel.scrollWidth > collapseLabel.clientWidth,
      };
    });
    expect(bounds.sortRight).toBeLessThanOrEqual(bounds.cornerRight);
    expect(bounds.collapseLabelOverflow).toBe('ellipsis');
    expect(bounds.collapseLabelIsClipped).toBe(true);
  });

  test('SortableJS project dragging does not change the horizontal timeline position', async ({ appPage: page }) => {
    await page.locator('#project-sort-toggle').click();
    const scroll = page.locator('#grid-scroll');
    await scroll.evaluate(el => { el.scrollLeft = 200; });
    const before = await scroll.evaluate(el => el.scrollLeft);

    const source = page.locator('.left-cell.proj').first().locator('.project-drag-handle');
    const target = page.locator('.left-cell.proj').nth(1);
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    const scrollBox = await scroll.boundingBox();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(scrollBox.x + scrollBox.width - 2, targetBox.y + targetBox.height / 2, { steps: 10 });
    await page.waitForTimeout(400);
    const duringDrag = await scroll.evaluate(el => el.scrollLeft);
    await page.mouse.up();

    expect(duringDrag).toBe(before);
    await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBe(before);
  });

  test('dedicated sort mode reorders projects by drag and drop and persists the order', async ({ appPage: page }) => {
    const names = page.locator('.left-cell.proj .name');
    const initialOrder = await names.allTextContents();
    const expectedOrder = [initialOrder.at(-1), ...initialOrder.slice(0, -1)];

    await expect(page.locator('.left-cell.task:visible')).toHaveCount(8);
    await expect(page.locator('.project-drag-handle:visible')).toHaveCount(0);
    await page.locator('#project-sort-toggle').click();
    await expect(page.locator('#project-sort-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(0);
    await expect(page.locator('.project-drag-handle:visible')).toHaveCount(initialOrder.length);
    await expect(page.locator('.collapse-toggle:visible')).toHaveCount(0);
    await expect(page.locator('#collapse-all-btn')).toBeHidden();
    expect(await page.evaluate(() => typeof window.Sortable)).toBe('function');
    expect(await page.evaluate(() => Boolean(window.Sortable.get(document.getElementById('grid'))))).toBe(true);

    await names.first().click();
    await expect(page.locator('#project-popover')).toHaveCount(0);

    const source = page.locator('.left-cell.proj').last().locator('.project-drag-handle');
    const target = page.locator('.left-cell.proj').first();
    const reorderResponse = page.waitForResponse(response =>
      response.url().includes('/projects/reorder/') && response.request().method() === 'POST'
    );
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 2, { steps: 10 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    expect((await reorderResponse).status()).toBe(200);

    await expect.poll(() => names.allTextContents()).toEqual(expectedOrder);
    await expect(page.locator('#project-sort-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.project-drag-handle:visible')).toHaveCount(initialOrder.length);
    await page.locator('#project-sort-toggle').click();
    await expect(page.locator('.project-drag-handle:visible')).toHaveCount(0);
    await expect(page.locator('.collapse-toggle:visible')).toHaveCount(initialOrder.length);
    await expect(page.locator('#collapse-all-btn')).toBeVisible();

    await page.reload();
    await expect(names).toHaveText(expectedOrder);
  });
});


// =============================================================================
// Resource view
// =============================================================================
test.describe('resource view', () => {
  test('shows person-grouped rows with correct task counts', async ({ appPage: page }) => {
    await page.goto('/resources/');

    // 3 people + 1 "Unassigned" = 4 header rows
    await expect(page.locator('.left-cell.proj')).toHaveCount(4);
    await expect(page.locator('.left-cell.proj', { hasText: 'Alex Chen' })).toBeVisible();
    await expect(page.locator('.left-cell.proj', { hasText: 'Sam Patel' })).toBeVisible();
    await expect(page.locator('.left-cell.proj', { hasText: 'Riley Wong' })).toBeVisible();
    await expect(page.locator('.left-cell.proj', { hasText: 'Unassigned' })).toBeVisible();
    await expect(page.locator('.left-cell.proj', { hasText: 'Alex Chen' }).locator('.team-badge')).toHaveText(['Backend', 'Infrastructure']);
    await expect(page.locator('.left-cell.proj', { hasText: 'Sam Patel' }).locator('.team-badge')).toHaveText(['Backend']);

    // Default filter hides "done" tasks. 7 non-done tasks → 10 bars
    // Alex: t2,t7,t8=3  Sam: t2,t3,t5=3  Riley: t4,t5,t6,t8=4  Unassigned: 0
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(10);
  });

  test('no milestones in resource view', async ({ appPage: page }) => {
    await page.goto('/resources/');
    await expect(page.locator('.milestone')).toHaveCount(0);
  });

  test('status filter toggles hide and show tasks', async ({ appPage: page }) => {
    await page.goto('/resources/');
    // Default: Done is off, the two active date-derived statuses are on.
    await expect(page.locator('#status-filter .status-chip.active')).toHaveCount(2);
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(10);

    // Enable Done → all 11 bars visible
    await page.locator('#status-filter .status-chip', { hasText: 'Done' }).click();
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(11);
    await expect(page.locator('#status-filter .status-chip.active')).toHaveCount(3);

    // Disable In progress → hides 4 bars (t2 under Alex+Sam, plus t4 and t7).
    await page.locator('#status-filter .status-chip', { hasText: 'In progress' }).click();
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(7);
    await expect(page.locator('#status-filter .status-chip.active')).toHaveCount(2);
  });

  test('team filter limits resource view to people in selected teams', async ({ appPage: page }) => {
    await page.goto('/resources/');
    await page.locator('#team-filter summary').click();
    await page.locator('#team-filter .team-filter-option', { hasText: 'Backend' }).click();

    await expect(page.locator('#team-filter summary')).toContainText('Teams (1)');
    await expect(page.locator('.left-cell.proj')).toHaveCount(2);
    await expect(page.locator('.left-cell.proj', { hasText: 'Alex Chen' })).toBeVisible();
    await expect(page.locator('.left-cell.proj', { hasText: 'Sam Patel' })).toBeVisible();
    await expect(page.locator('.left-cell.proj', { hasText: 'Riley Wong' })).toHaveCount(0);
    await expect(page.locator('.left-cell.proj', { hasText: 'Unassigned' })).toHaveCount(0);
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(6);

    await page.locator('#team-filter summary').click();
    await page.locator('#team-filter .team-filter-option', { hasText: 'Backend' }).click();
    await expect(page.locator('.left-cell.proj')).toHaveCount(4);
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(10);
  });

  test('no dependency arrows in resource view', async ({ appPage: page }) => {
    await page.goto('/resources/');
    await expect(page.locator('#arrows .hit')).toHaveCount(0);
  });

  test('view switch links navigate between views', async ({ appPage: page }) => {
    const nav = page.locator('.drawer-side .menu');
    // Start in project view
    await expect(nav.locator('a.menu-active')).toHaveText(/Projects/);

    // Click Resources
    await nav.locator('a', { hasText: 'Resources' }).click();
    await page.waitForURL('**/resources/');
    await expect(nav.locator('a.menu-active')).toHaveText(/Resources/);
    await expect(page.locator('.left-cell.proj', { hasText: 'Alex Chen' })).toBeVisible();

    // Click back to Projects
    await nav.locator('a', { hasText: 'Projects' }).click();
    await page.waitForURL(/\/$/);
    await expect(nav.locator('a.menu-active')).toHaveText(/Projects/);
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toBeVisible();
  });
});


// =============================================================================
// Task popover
// =============================================================================
test.describe('task popover', () => {
  // The slide-in is a 180ms CSS transform transition; wait for it to settle
  // before measuring boundingBox(). At rest the drawer's right edge sits
  // exactly on the viewport right edge (transform: translateX(0)).
  async function waitForDrawerOpen(page) {
    await page.waitForFunction(() => {
      const el = document.getElementById('drawer');
      return el && getComputedStyle(el).transform === 'matrix(1, 0, 0, 1, 0, 0)';
    });
  }

  test('clicking a task in the left list centers its timeframe and opens the editor', async ({ appPage: page }) => {
    await page.goto('/?zoom=day');

    const task = page.locator('.left-cell.task', { hasText: 'Migrate /users endpoints' });
    const taskId = await task.getAttribute('data-task-id');
    const expectedScrollLeft = await page.evaluate((id) => {
      const sc = document.getElementById('grid-scroll');
      const bar = document.getElementById(`bar-${id}`);
      const leftW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w')) || 240;
      const x = parseFloat(bar.style.left);
      const width = parseFloat(bar.style.width);
      const target = x + width / 2 - (sc.clientWidth - leftW) / 2;
      const expected = Math.max(0, Math.min(sc.scrollWidth - sc.clientWidth, target));
      sc.scrollLeft = expected < (sc.scrollWidth - sc.clientWidth) / 2
        ? sc.scrollWidth - sc.clientWidth
        : 0;
      return Math.round(expected);
    }, taskId);

    await task.click();

    await expect(page.locator('#task-popover input[name=title]')).toHaveValue('Migrate /users endpoints');
    await expect.poll(() => page.locator('#grid-scroll').evaluate(el => el.scrollLeft)).toBeCloseTo(expectedScrollLeft, 0);
  });

  test('clicking a bar slides the drawer in flush against the right edge', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await page.waitForSelector('#task-popover');
    await waitForDrawerOpen(page);
    const drawer = await page.locator('#drawer').boundingBox();
    const viewport = page.viewportSize();
    expect(Math.abs(drawer.x + drawer.width - viewport.width)).toBeLessThan(2);
  });

  test('clicking a project header slides the drawer in flush against the right edge', async ({ appPage: page }) => {
    const header = page.locator('.left-cell.proj', { hasText: 'API Migration' });
    await header.click();
    await page.waitForSelector('#project-popover');
    await waitForDrawerOpen(page);
    const drawer = await page.locator('#drawer').boundingBox();
    const viewport = page.viewportSize();
    expect(Math.abs(drawer.x + drawer.width - viewport.width)).toBeLessThan(2);
  });

  test('clicking a bar opens the popover without a manual status field', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await expect(page.locator('#task-popover')).toBeVisible();
    await expect(page.locator('#task-popover input[name=title]')).toHaveValue(/Migrate/);
    await expect(page.locator('#task-popover input[name=start]')).toBeVisible();
    await expect(page.locator('#task-popover input[name=end]')).toBeVisible();
    await expect(page.locator('#task-popover select[name=status]')).toHaveCount(0);
    await expect(page.locator('#task-popover select[name=project_id]')).toBeVisible();
  });

  test('task popover fields use DaisyUI field components', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await expect(page.locator('#task-popover fieldset.fieldset')).toHaveCount(8);
    await expect(page.locator('#task-popover label.label').first()).toHaveText('Title');
    await expect(page.locator('#task-popover input[name=title]')).toHaveClass(/\binput\b/);
    await expect(page.locator('#task-popover textarea[name=description]')).toHaveClass(/\btextarea\b/);
    await expect(page.locator('#task-popover input[name=has_milestone]')).toHaveCount(0);
    await expect(page.locator('#task-popover input[name=milestone_title]')).toHaveClass(/\binput\b/);
    await expect(page.locator('#task-popover select[name=project_id]')).toHaveClass(/\bselect\b/);
  });

  test('assignee multi-select options are shown as a vertical list', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    const assignees = page.locator('#task-assignees');
    await expect(assignees).toBeVisible();
    await expect(assignees.locator('option', { hasText: 'Alex Chen — Backend, Infrastructure' })).toHaveCount(1);

    const layout = await assignees.evaluate(el => {
      const rects = Array.from(el.options).map(option => {
        const rect = option.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const style = getComputedStyle(el);
      return { display: style.display, appearance: style.appearance, rects };
    });

    expect(layout.display).toBe('block');
    expect(layout.appearance).not.toBe('base-select');
    for (let i = 1; i < layout.rects.length; i++) {
      expect(Math.abs(layout.rects[i].x - layout.rects[0].x)).toBeLessThan(2);
      expect(layout.rects[i].y).toBeGreaterThan(layout.rects[i - 1].y + 1);
    }
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

  test('the description textarea fills the popover width and uses readable text size', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await expect(page.locator('#task-popover')).toBeVisible();
    const titleW = await page.locator('#task-popover input[name=title]')
      .evaluate(el => el.getBoundingClientRect().width);
    const desc = page.locator('#task-popover textarea[name=description]');
    const descW = await desc.evaluate(el => el.getBoundingClientRect().width);
    expect(Math.abs(descW - titleW)).toBeLessThan(2);
    await expect(desc).toHaveCSS('font-size', '16px');
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
    await expect(page.locator('#task-popover .dep-row')).toHaveCount(2);
    await page.locator('#task-popover .dep-row .dep-remove').first().click();
    // Chart re-renders (arrow count drops by 1) AND the open popover's
    // deps-list re-renders so the removed row is gone — otherwise the
    // ghost button sticks around in the drawer.
    await expect(page.locator('#arrows .hit')).toHaveCount(5);
    await expect(page.locator('#task-popover .dep-row')).toHaveCount(1);
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
    // Move far enough to snap to a later day at the default day density.
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
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const ppd = parseFloat(await page.locator('#grid-scroll').evaluate(el => el.dataset.pxPerDay));
    // Right-edge handle sits at right:0 width:6 — aim 3px from the right edge.
    await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 3 + ppd, box.y + box.height / 2, { steps: 5 });
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
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const ppd = parseFloat(await page.locator('#grid-scroll').evaluate(el => el.dataset.pxPerDay));
    // Left-edge handle sits at left:0 width:6 — aim 3px in from the left.
    await page.mouse.move(box.x + 3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 3 + ppd, box.y + box.height / 2, { steps: 5 });
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
    await bar.scrollIntoViewIfNeeded();
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
    await from.scrollIntoViewIfNeeded();
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
    await from.scrollIntoViewIfNeeded();
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
    await from.scrollIntoViewIfNeeded();
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
    // Let the initial automatic scroll-to-today settle, then scroll the chart
    // horizontally to a known offset.
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      document.getElementById('grid-scroll').scrollLeft = 240;
    });
    const before = await page.evaluate(() =>
      document.getElementById('grid-scroll').scrollLeft
    );
    expect(before).toBe(240);

    // Create a dep with endpoints brought into view explicitly. At day density
    // the chart is much wider, so seeded objects are often off-screen.
    const from = page.locator('.bar', { hasText: 'Tutorial flow v2' });
    const to = page.locator('.bar', { hasText: 'Audit IAM policies' });
    await from.scrollIntoViewIfNeeded();
    await to.scrollIntoViewIfNeeded();
    const committedScroll = await page.evaluate(() =>
      document.getElementById('grid-scroll').scrollLeft
    );
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
    expect(after).toBe(committedScroll);
  });

  test('dragging from a bar dep-handle to another bar creates a dependency', async ({ appPage: page }) => {
    await expect(page.locator('#arrows .hit')).toHaveCount(6);
    // Use two tasks that aren't already linked.
    const from = page.locator('.bar', { hasText: 'A/B test setup' });
    const to = page.locator('.bar', { hasText: 'Audit IAM policies' });
    await from.scrollIntoViewIfNeeded();
    await to.scrollIntoViewIfNeeded();
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
    await from.scrollIntoViewIfNeeded();
    await to.scrollIntoViewIfNeeded();
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
  test('dragging a bar updates its dependency arrows live during the drag', async ({ appPage: page }) => {
    // t2 ("Migrate /users endpoints") sits between two deps: t1→t2 and t2→t3.
    // Dragging it should move both arrow endpoints in real time, before the
    // SSE patch comes back.
    const before = await page.locator('#arrows .hit')
      .evaluateAll(els => els.map(e => e.getAttribute('d')));

    const target = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const box = await target.boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 8 });

    // Mid-drag (no mouseup yet) — at least one arrow's d should differ already.
    const mid = await page.locator('#arrows .hit')
      .evaluateAll(els => els.map(e => e.getAttribute('d')));
    await page.mouse.up();

    const changed = mid.filter((d, i) => d !== before[i]).length;
    expect(changed).toBeGreaterThan(0);
  });

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
    const ppd = parseFloat(await page.locator('#grid-scroll').evaluate(el => el.dataset.pxPerDay));

    await t6.scrollIntoViewIfNeeded();
    await t6.click({ modifiers: ['Shift'] });
    await t8.scrollIntoViewIfNeeded();
    await t8.click({ modifiers: ['Shift'] });
    await expect(page.locator('.bar.selected')).toHaveCount(2);

    // Drag t6 right far enough to snap to a later day.
    await t6.scrollIntoViewIfNeeded();
    const box = await t6.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + ppd * 2, box.y + box.height / 2, { steps: 8 });
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
    await t6.scrollIntoViewIfNeeded();
    await t6.click({ modifiers: ['Shift'] });

    const other = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const beforeOther = parseFloat(await other.evaluate(el => el.style.left));
    const before6 = parseFloat(await t6.evaluate(el => el.style.left));
    const oldStartOther = await other.evaluate(el => el.dataset.start);
    const ppd = parseFloat(await page.locator('#grid-scroll').evaluate(el => el.dataset.pxPerDay));

    // Drag another, non-selected bar — the selected bar should stay put.
    await other.evaluate(el => {
      document.getElementById('grid-scroll').scrollLeft = Math.max(0, parseFloat(el.style.left) - 80);
    });
    await other.scrollIntoViewIfNeeded();
    const box = await other.boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 30 + ppd * 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(
      ([oldStart]) => {
        const el = [...document.querySelectorAll('.bar')]
          .find(b => b.textContent.includes('Migrate /users endpoints'));
        return el && el.dataset.start !== oldStart;
      },
      [oldStartOther],
      { timeout: 5000 }
    );

    const afterOther = parseFloat(await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).evaluate(el => el.style.left));
    const after6 = parseFloat(await page.locator('.bar', { hasText: 'A/B test setup' }).evaluate(el => el.style.left));
    expect(afterOther).toBeGreaterThan(beforeOther);
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
  test('task milestones are edited on the task and follow task movement', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Cutover and deprecation' });
    await bar.click();
    await expect(page.locator('#task-popover')).toBeVisible();
    await page.fill('#task-popover input[name=milestone_title]', 'Beta customer announcement');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('#task-popover')).toHaveCount(0);

    await expect(page.locator('.milestone-label', { hasText: 'Beta customer announcement' })).toBeVisible();

    const taskId = await bar.getAttribute('data-task-id');
    const beforeEnd = await bar.getAttribute('data-end');
    const beforeMilestoneDate = await page.locator(`.milestone[data-task-id="${taskId}"]`).getAttribute('data-date');
    expect(beforeMilestoneDate).toBe(beforeEnd);

    const box = await bar.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction(
      ([oldEnd]) => {
        const el = [...document.querySelectorAll('.bar')]
          .find(b => b.textContent.includes('Cutover and deprecation'));
        return el && el.dataset.end !== oldEnd;
      },
      [beforeEnd],
      { timeout: 5000 }
    );

    const afterEnd = await page.locator('.bar', { hasText: 'Cutover and deprecation' }).getAttribute('data-end');
    const afterMilestoneDate = await page.locator(`.milestone[data-task-id="${taskId}"]`).getAttribute('data-date');
    expect(afterMilestoneDate).toBe(afterEnd);
  });

  test('task bars visually end at the start of their end date', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Cutover and deprecation' });
    const visual = await bar.evaluate((el) => {
      const grid = document.getElementById('grid-scroll');
      const dayMs = 24 * 60 * 60 * 1000;
      const end = new Date(`${el.dataset.end}T00:00:00Z`);
      const chartStart = new Date(`${grid.dataset.chartStart}T00:00:00Z`);
      return {
        right: parseFloat(el.style.left) + parseFloat(el.style.width),
        expectedRight: ((end - chartStart) / dayMs) * parseFloat(grid.dataset.pxPerDay),
      };
    });

    expect(Math.abs(visual.right - visual.expectedRight)).toBeLessThan(1);
  });

  test('task-linked milestone diamond visually aligns with the owning task end', async ({ appPage: page }) => {
    const milestone = page.locator('.milestone[data-task-id]').first();
    const taskId = await milestone.getAttribute('data-task-id');
    const bar = page.locator(`#bar-${taskId}`);

    const visual = await page.evaluate((id) => {
      const ms = document.querySelector(`.milestone[data-task-id="${id}"]`);
      const task = document.querySelector(`#bar-${id}`);
      return {
        milestoneCenter: parseFloat(ms.style.left) + 7,
        taskRight: parseFloat(task.style.left) + parseFloat(task.style.width),
      };
    }, taskId);

    expect(Math.abs(visual.milestoneCenter - visual.taskRight)).toBeLessThan(1);
  });

  test('dragging a task-linked milestone updates the owning task end date', async ({ appPage: page }) => {
    const milestone = page.locator('.milestone[data-task-id]').first();
    const taskId = await milestone.getAttribute('data-task-id');
    const bar = page.locator(`#bar-${taskId}`);
    const beforeEnd = await bar.getAttribute('data-end');
    await milestone.scrollIntoViewIfNeeded();
    const box = await milestone.boundingBox();
    const ppd = parseFloat(await page.locator('#grid-scroll').evaluate(el => el.dataset.pxPerDay));

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + ppd * 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction(
      ([id, oldEnd]) => {
        const el = document.querySelector(`#bar-${id}`);
        return el && el.dataset.end !== oldEnd;
      },
      [taskId, beforeEnd],
      { timeout: 5000 }
    );

    const afterEnd = await page.locator(`#bar-${taskId}`).getAttribute('data-end');
    const afterMilestoneDate = await page.locator(`.milestone[data-task-id="${taskId}"]`).getAttribute('data-date');
    expect(afterEnd).toBe(afterMilestoneDate);
    expect(afterEnd > beforeEnd).toBe(true);
  });

  test('clicking a task milestone opens the regular milestone editor', async ({ appPage: page }) => {
    const ms = page.locator('.chart-row.proj .milestone').first();
    const taskId = await ms.getAttribute('data-task-id');
    await ms.scrollIntoViewIfNeeded();
    const box = await ms.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('#milestone-popover');
    await expect(page.locator('#milestone-popover input[name=title]')).toHaveValue('v2 API beta');
    await expect(page.locator('#milestone-popover textarea[name=description]')).toBeVisible();
    await expect(page.locator('#milestone-popover button', { hasText: 'Delete' })).toBeVisible();
    await expect(page.locator('#milestone-popover button', { hasText: 'Cancel' })).toHaveCount(0);
    await expect(page.locator(`#bar-${taskId}`)).toBeVisible();
  });

  test('milestone editor requires a description before saving', async ({ appPage: page }) => {
    const ms = page.locator('.chart-row.proj .milestone').first();
    await ms.scrollIntoViewIfNeeded();
    const box = await ms.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('#milestone-popover')).toBeVisible();

    const description = page.locator('#milestone-popover textarea[name=description]');
    await expect(description).toHaveAttribute('required', '');
    await description.fill('');
    await page.locator('#milestone-popover button[type=submit]').click();

    await expect(page.locator('#milestone-popover')).toBeVisible();
    await expect(description).toBeFocused();
    expect(await description.evaluate(el => el.validity.valueMissing)).toBe(true);
  });

  test('editing the task milestone title updates the milestone label', async ({ appPage: page }) => {
    await page.locator('.bar', { hasText: 'Cutover and deprecation' }).click();
    await expect(page.locator('#task-popover')).toBeVisible();
    await page.fill('#task-popover input[name=milestone_title]', 'Beta release cutover');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('.milestone-label', { hasText: 'Beta release cutover' })).toBeVisible();
  });

  test('clearing a task milestone title removes its diamond from the chart', async ({ appPage: page }) => {
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    await page.locator('.bar', { hasText: 'Cutover and deprecation' }).click();
    await expect(page.locator('#task-popover')).toBeVisible();
    await page.locator('#task-milestone-title').fill('');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(1);
  });

  test('task milestone input autocomplete only lists free milestones from the same project', async ({ appPage: page }) => {
    const project = page.locator('.project-group').filter({ hasText: 'Onboarding revamp' });
    await project.locator('.left-cell.proj').click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await page.click('#project-popover #pp-add-milestone');
    await placeMilestoneGhost(page, project);
    await page.fill('#milestone-popover input[name=title]', 'Onboarding-only checkpoint');
    await page.fill('#milestone-popover textarea[name=description]', 'Onboarding-only checkpoint description.');
    await page.click('#milestone-popover button[type=submit]');
    await expect(page.locator('#milestone-popover')).toHaveCount(0);

    await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).click();
    await expect(page.locator('#task-popover')).toBeVisible();
    const listId = await page.locator('#task-milestone-title').getAttribute('list');
    expect(listId).toBeTruthy();
    await expect(page.locator(`#${listId} option[value="Onboarding-only checkpoint"]`)).toHaveCount(0);
  });

  test('task milestone input can autocomplete and link an existing free milestone', async ({ appPage: page }) => {
    const project = page.locator('.project-group').filter({ hasText: 'API Migration' });
    await project.locator('.left-cell.proj').click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await page.click('#project-popover #pp-add-milestone');
    await placeMilestoneGhost(page, project);
    await page.fill('#milestone-popover input[name=title]', 'Reusable checkpoint');
    await page.fill('#milestone-popover textarea[name=description]', 'Reusable checkpoint description.');
    await page.click('#milestone-popover button[type=submit]');
    await expect(page.locator('#milestone-popover')).toHaveCount(0);

    const freeMilestone = page.locator('.milestone:not([data-task-id])').first();
    await expect(freeMilestone).toBeVisible();
    const milestoneId = await freeMilestone.getAttribute('data-milestone-id');

    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const taskId = await bar.getAttribute('data-task-id');
    await bar.click();
    await expect(page.locator('#task-popover')).toBeVisible();

    const input = page.locator('#task-milestone-title');
    const listId = await input.getAttribute('list');
    expect(listId).toBeTruthy();
    await expect(page.locator(`#${listId} option[value="Reusable checkpoint"]`)).toHaveCount(1);

    await input.fill('Reusable checkpoint');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('#task-popover')).toHaveCount(0);

    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(3);
    await expect(page.locator(`#ms-${milestoneId}`)).toHaveAttribute('data-task-id', taskId);
    await expect(page.locator('.milestone-label', { hasText: 'Reusable checkpoint' })).toBeVisible();
    expect(await page.locator(`#ms-${milestoneId}`).getAttribute('data-date'))
      .toBe(await page.locator(`#bar-${taskId}`).getAttribute('data-end'));
  });

  test('+ Project at the bottom adds a new project at the end', async ({ appPage: page }) => {
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);
    await page.locator('.add-project-row').last().click();
    await expect(page.locator('.left-cell.proj')).toHaveCount(4);
    // New project is the last entry in the list
    const lastProj = page.locator('.left-cell.proj').last();
    await expect(lastProj).toContainText('New project');
  });

  test('+ Project at the top adds a new project at the start', async ({ appPage: page }) => {
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);
    await page.locator('.add-project-row').first().click();
    await expect(page.locator('.left-cell.proj')).toHaveCount(4);
    // New project is the first entry in the list
    const firstProj = page.locator('.left-cell.proj').first();
    await expect(firstProj).toContainText('New project');
  });

  test('explicit creation controls distinguish a new task row from milestone placement', async ({ appPage: page }) => {
    const project = page.locator('.project-group').first();
    const projectRow = project.locator('.chart-row.proj');
    const projectRowBox = await projectRow.boundingBox();
    const sidebar = await project.locator('.left-cell.proj').boundingBox();
    const barsBefore = await page.locator('.bar').count();
    const milestonesBefore = await page.locator('.chart-row.proj .milestone').count();

    const addTask = project.getByRole('button', { name: 'Add task' });
    const addMilestone = project.getByRole('button', { name: 'Add milestone' });
    await expect(addTask).toBeVisible();
    await expect(addMilestone).toBeVisible();

    await addTask.click();
    await expect(addTask).toHaveAttribute('aria-pressed', 'true');
    const draftLabel = project.locator('.task-creation-left');
    const draftRow = project.locator('.task-creation-timeline');
    await expect(draftLabel).toContainText('New task');
    await expect(draftRow).toHaveClass(/creation-target/);
    await expect(draftRow.locator('.task-creation-ghost')).toContainText('New task');
    await expect(page.locator('#creation-hint')).toContainText('new task row');

    const draftBox = await draftRow.boundingBox();
    const chartX = sidebar.x + sidebar.width + 80;
    const draftY = draftBox.y + draftBox.height / 2;
    await page.mouse.click(chartX, draftY);

    await expect(page.locator('.bar')).toHaveCount(barsBefore + 1);
    await expect(page.locator('#task-popover')).toBeVisible();
    const newTask = page.locator('.bar', { hasText: 'New task' });
    const taskDates = await newTask.evaluate(el => ({ start: el.dataset.start, end: el.dataset.end }));
    const duration = (Date.parse(taskDates.end) - Date.parse(taskDates.start)) / 86400000;
    expect(duration).toBe(7);
    await expect(addTask).toHaveAttribute('aria-pressed', 'false');
    await expect(project.locator('.task-creation-timeline')).toHaveCount(0);
    await expect(page.locator('#creation-hint')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await addMilestone.click();
    await expect(addMilestone).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#creation-hint')).toContainText('preview a date');
    const milestoneGhost = projectRow.locator('.creation-milestone-preview');
    await expect(milestoneGhost).toBeVisible();
    await expect(milestoneGhost.locator('.creation-date-tooltip')).toHaveText(/\d{4}-\d{2}-\d{2}/);
    const initialGhostLeft = await milestoneGhost.evaluate(el => el.style.left);

    const chartXForMilestone = sidebar.x + sidebar.width + 180;
    const chartYForMilestone = projectRowBox.y + projectRowBox.height / 2;
    await page.mouse.move(chartXForMilestone, chartYForMilestone);
    await expect.poll(() => milestoneGhost.evaluate(el => el.style.left)).not.toBe(initialGhostLeft);
    await page.mouse.down();
    await expect(page.locator('.creation-milestone-preview')).toBeVisible();
    await expect(page.locator('.creation-milestone-preview .creation-date-tooltip')).toHaveText(/\d{4}-\d{2}-\d{2}/);
    await page.mouse.up();

    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(milestonesBefore + 1);
    await expect(page.locator('#milestone-popover')).toBeVisible();
    await expect(addMilestone).toHaveAttribute('aria-pressed', 'false');
  });

  test('Escape cancels the highlighted task row without creating anything', async ({ appPage: page }) => {
    const barsBefore = await page.locator('.bar').count();
    const project = page.locator('.project-group').first();
    const addTask = project.getByRole('button', { name: 'Add task' });
    const sidebar = await project.locator('.left-cell.proj').boundingBox();
    const chartX = sidebar.x + sidebar.width + 30;

    await addTask.click();
    const draftRow = project.locator('.task-creation-timeline');
    const rowBox = await draftRow.boundingBox();
    await page.mouse.move(chartX, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(chartX + 60, rowBox.y + rowBox.height / 2);
    await expect(draftRow.locator('.task-creation-ghost.placing')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(project.locator('.task-creation-timeline')).toHaveCount(0);
    await expect(page.locator('#creation-hint')).toHaveCount(0);
    await expect(addTask).toHaveAttribute('aria-pressed', 'false');
    await page.mouse.up();
    await expect(page.locator('.bar')).toHaveCount(barsBefore);
  });

  test('an unarmed project row does not create, while Shift-click remains a milestone shortcut', async ({ appPage: page }) => {
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    const barsBefore = await page.locator('.bar').count();

    const leftCell = page.locator('.left-cell.proj').first();
    const lcBox = await leftCell.boundingBox();
    const row = page.locator('.chart-row.proj').first();
    const rowBox = await row.boundingBox();
    const clickX = lcBox.x + lcBox.width + 200;
    const clickY = rowBox.y + rowBox.height / 2;

    await page.mouse.click(clickX, clickY);
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    await expect(page.locator('.bar')).toHaveCount(barsBefore);

    await page.keyboard.down('Shift');
    await page.mouse.click(clickX, clickY);
    await page.keyboard.up('Shift');
    await expect(page.locator('#milestone-popover')).toBeVisible();
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(3);
  });

  test('an unarmed drag does not create, while Shift-drag remains a task shortcut', async ({ appPage: page }) => {
    const barsBefore = await page.locator('.bar').count();
    const project = page.locator('.project-group').first();
    const rowBox = await project.locator('.chart-row.proj').boundingBox();
    const sidebar = await project.locator('.left-cell.proj').boundingBox();
    const startX = sidebar.x + sidebar.width + 30;
    const y = rowBox.y + rowBox.height / 2;

    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 100, y);
    await page.mouse.up();
    await expect(page.locator('.bar')).toHaveCount(barsBefore);

    await page.keyboard.down('Shift');
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 100, y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(page.locator('.bar')).toHaveCount(barsBefore + 1);
    await expect(page.locator('#task-popover')).toBeVisible();
  });

  test('Cancel on a newly-created milestone deletes it without confirmation', async ({ appPage: page }) => {
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    let sawDialog = false;
    page.on('dialog', async dialog => {
      sawDialog = true;
      await dialog.dismiss();
    });

    const project = page.locator('.project-group').first();
    const leftCell = project.locator('.left-cell.proj');
    const lcBox = await leftCell.boundingBox();
    const row = project.locator('.chart-row.proj');
    const rowBox = await row.boundingBox();
    await project.getByRole('button', { name: 'Add milestone' }).click();
    await page.mouse.click(lcBox.x + lcBox.width + 200, rowBox.y + rowBox.height / 2);

    await expect(page.locator('#milestone-popover')).toBeVisible();
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(3);
    await expect(page.locator('#milestone-popover button', { hasText: 'Delete' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.locator('#milestone-popover')).toHaveCount(0);
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    expect(sawDialog).toBe(false);
  });

  test('Escape on a newly-created task deletes it without confirmation', async ({ appPage: page }) => {
    const barsBefore = await page.locator('.bar').count();
    let sawDialog = false;
    page.on('dialog', async dialog => {
      sawDialog = true;
      await dialog.dismiss();
    });

    const project = page.locator('.project-group').first();
    const sidebar = await project.locator('.left-cell.proj').boundingBox();
    const chartX = sidebar.x + sidebar.width + 20;
    await project.getByRole('button', { name: 'Add task' }).click();
    const row = project.locator('.task-creation-timeline');
    const rowBox = await row.boundingBox();
    await page.mouse.move(chartX, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(chartX + 120, rowBox.y + rowBox.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator('.bar')).toHaveCount(barsBefore + 1);
    await expect(page.locator('#task-popover')).toBeVisible();
    await expect(page.locator('#task-popover button', { hasText: 'Delete' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await expect(page.locator('#task-popover')).toHaveCount(0);
    await expect(page.locator('.bar')).toHaveCount(barsBefore);
    expect(sawDialog).toBe(false);
  });

  test('the highlighted task row previews and creates a custom date range', async ({ appPage: page }) => {
    const milestonesBefore = await page.locator('.chart-row.proj .milestone').count();
    const barsBefore = await page.locator('.bar').count();

    const project = page.locator('.project-group').first();
    const sidebar = await project.locator('.left-cell.proj').boundingBox();
    const chartX = sidebar.x + sidebar.width + 20;
    await project.getByRole('button', { name: 'Add task' }).click();
    const row = project.locator('.task-creation-timeline');
    const rowBox = await row.boundingBox();
    await page.mouse.move(chartX, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(chartX + 120, rowBox.y + rowBox.height / 2, { steps: 8 });
    const ghost = row.locator('.task-creation-ghost');
    await expect(ghost).toHaveClass(/placing/);
    await expect(ghost.locator('.creation-date-tooltip')).toContainText('–');
    await page.mouse.up();

    await expect(page.locator('.bar')).toHaveCount(barsBefore + 1);
    expect(await page.locator('.chart-row.proj .milestone').count()).toBe(milestonesBefore);
  });

  test('+ Add task in the project popover opens the highlighted scheduling row', async ({ appPage: page }) => {
    const barsBefore = await page.locator('.bar').count();
    const project = page.locator('.project-group').filter({ hasText: 'API Migration' });
    await project.locator('.left-cell.proj').click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await page.click('#project-popover #pp-add-task');

    await expect(page.locator('#project-popover')).toHaveCount(0);
    await expect(page.locator('.bar')).toHaveCount(barsBefore);
    await expect(project.locator('.task-creation-left')).toContainText('New task');
    const row = project.locator('.task-creation-timeline');
    const rowBox = await row.boundingBox();
    const sidebar = await project.locator('.left-cell.proj').boundingBox();
    await page.mouse.click(sidebar.x + sidebar.width + 40, rowBox.y + rowBox.height / 2);
    await expect(page.locator('.bar')).toHaveCount(barsBefore + 1);
    await expect(page.locator('#task-popover')).toBeVisible();
  });

  test('+ Add milestone in the project popover opens a ghost milestone for placement', async ({ appPage: page }) => {
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    const project = page.locator('.project-group').filter({ hasText: 'API Migration' });
    await project.locator('.left-cell.proj').click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await page.click('#project-popover #pp-add-milestone');

    await expect(page.locator('#project-popover')).toHaveCount(0);
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    const row = project.locator('.chart-row.proj');
    await expect(row.locator('.creation-milestone-preview')).toBeVisible();
    const rowBox = await row.boundingBox();
    const sidebar = await project.locator('.left-cell.proj').boundingBox();
    await page.mouse.click(sidebar.x + sidebar.width + 140, rowBox.y + rowBox.height / 2);
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(3);
    await expect(page.locator('#milestone-popover')).toBeVisible();
  });

  test('clicking a project header opens the project popover', async ({ appPage: page }) => {
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await expect(page.locator('#project-popover input[name=name]')).toHaveValue('API Migration');
  });

  test('project descriptions can be edited from the sidebar', async ({ appPage: page }) => {
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await page.locator('#project-popover textarea[name=description]').fill('Move all public API traffic to v2 before GA.');
    await page.locator('#project-popover button[type=submit]').click();
    await expect(page.locator('#project-popover')).toHaveCount(0);

    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await expect(page.locator('#project-popover textarea[name=description]')).toHaveValue('Move all public API traffic to v2 before GA.');
  });

  test('project Teams notification settings persist', async ({ appPage: page }) => {
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await expect(page.locator('#project-popover input[name=teams_webhook_url]')).not.toBeVisible();
    await page.getByLabel('Toggle Teams notification settings').check();
    await expect(page.locator('#project-popover input[name=teams_webhook_url]')).toBeVisible();

    await page.locator('#project-popover input[name=teams_webhook_url]').fill('http://127.0.0.1:54321/teams');
    await page.locator('#teams-event-milestone-created').check();
    await page.locator('#teams-event-milestone-moved').uncheck();
    await page.locator('#teams-event-milestone-updated').check();
    await page.locator('#teams-event-milestone-deleted').uncheck();
    await page.locator('#project-popover button[type=submit]').click();
    await expect(page.locator('#project-popover')).toHaveCount(0);

    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await page.getByLabel('Toggle Teams notification settings').check();
    await expect(page.locator('#project-popover input[name=teams_webhook_url]')).toHaveValue('http://127.0.0.1:54321/teams');
    await expect(page.locator('#teams-event-milestone-created')).toBeChecked();
    await expect(page.locator('#teams-event-milestone-moved')).not.toBeChecked();
    await expect(page.locator('#teams-event-milestone-updated')).toBeChecked();
    await expect(page.locator('#teams-event-milestone-deleted')).not.toBeChecked();
  });

  test('Teams notifications skip placeholder milestone creation', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
      await expect(page.locator('#project-popover')).toBeVisible();
      await page.getByLabel('Toggle Teams notification settings').check();
      await page.locator('#project-popover input[name=teams_webhook_url]').fill(webhook.url);
      await page.locator('#teams-event-milestone-created').check();
      await page.locator('#project-popover button[type=submit]').click();
      await expect(page.locator('#project-popover')).toHaveCount(0);

      const project = page.locator('.project-group').filter({ hasText: 'API Migration' });
      await project.locator('.left-cell.proj').click();
      await expect(page.locator('#project-popover')).toBeVisible();
      await page.locator('#project-popover #pp-add-milestone').click();
      await placeMilestoneGhost(page, project);
      await expect(page.locator('#milestone-popover input[name=title]')).toHaveValue('New milestone');
      await expect.poll(() => webhook.requests.length).toBe(0);
    } finally {
      await webhook.close();
    }
  });

  test('Teams notifications respect selected milestone events', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
      await expect(page.locator('#project-popover')).toBeVisible();
      await page.getByLabel('Toggle Teams notification settings').check();
      await page.locator('#project-popover input[name=teams_webhook_url]').fill(webhook.url);
      await page.locator('#teams-event-milestone-moved').uncheck();
      await page.locator('#teams-event-milestone-updated').check();
      await page.locator('#project-popover button[type=submit]').click();
      await expect(page.locator('#project-popover')).toHaveCount(0);

      const milestone = page.locator('.chart-row.proj .milestone').first();
      await milestone.scrollIntoViewIfNeeded();
      const milestoneId = await milestone.getAttribute('data-milestone-id');
      const oldDate = await milestone.getAttribute('data-date');
      const box = await milestone.boundingBox();
      const ppd = parseFloat(await page.locator('#grid-scroll').evaluate(el => el.dataset.pxPerDay));

      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + ppd * 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();

      await page.waitForFunction(
        ([id, before]) => {
          const el = document.querySelector(`#ms-${id}`);
          return el && el.dataset.date !== before;
        },
        [milestoneId, oldDate],
        { timeout: 5000 }
      );
      expect(webhook.requests).toHaveLength(0);

      const movedMilestone = page.locator(`#ms-${milestoneId}`);
      await movedMilestone.scrollIntoViewIfNeeded();
      const movedBox = await movedMilestone.boundingBox();
      await page.mouse.click(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
      await expect(page.locator('#milestone-popover')).toBeVisible();
      await page.locator('#milestone-popover input[name=title]').fill('v2 API beta updated for Teams');
      await page.locator('#milestone-popover button[type=submit]').click();
      await expect(page.locator('#milestone-popover')).toHaveCount(0);

      await expect.poll(() => webhook.requests.length).toBe(1);
      expect(webhook.requests[0].method).toBe('POST');
      expect(webhook.requests[0].json.type).toBe('message');
      const card = webhook.requests[0].json.attachments[0].content;
      expect(webhook.requests[0].json.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
      expect(card.type).toBe('AdaptiveCard');
      expect(card.body[0].text).toBe('Meilenstein v2 API beta updated for Teams aktualisiert');
      expect(card.body[1].text).toBe('Projekt: API Migration');
      expect(card.body[2].text)
        .toContain('demo hat den Titel von „v2 API beta“ in „v2 API beta updated for Teams“ geändert.');
      expect(card.body[3].facts).toContainEqual({ title: 'Titel', value: 'v2 API beta → v2 API beta updated for Teams' });
    } finally {
      await webhook.close();
    }
  });

  test('Teams description notifications include the new milestone description', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
      await expect(page.locator('#project-popover')).toBeVisible();
      await page.getByLabel('Toggle Teams notification settings').check();
      await page.locator('#project-popover input[name=teams_webhook_url]').fill(webhook.url);
      await page.locator('#teams-event-milestone-moved').uncheck();
      await page.locator('#teams-event-milestone-updated').check();
      await page.locator('#project-popover button[type=submit]').click();
      await expect(page.locator('#project-popover')).toHaveCount(0);

      const milestone = page.locator('.chart-row.proj .milestone').first();
      await milestone.scrollIntoViewIfNeeded();
      const box = await milestone.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.locator('#milestone-popover')).toBeVisible();

      const description = 'Neue Beschreibung für Teams mit mehr Kontext.';
      await page.locator('#milestone-popover textarea[name=description]').fill(description);
      await page.locator('#milestone-popover button[type=submit]').click();
      await expect(page.locator('#milestone-popover')).toHaveCount(0);

      await expect.poll(() => webhook.requests.length).toBe(1);
      const card = webhook.requests[0].json.attachments[0].content;
      expect(card.body[0].text).toBe('Meilenstein v2 API beta aktualisiert');
      expect(card.body[2].text).toContain('demo hat die Beschreibung geändert:');
      expect(card.body[2].text).toContain(description);
      expect(card.body[3].facts).not.toContainEqual({ title: 'Beschreibung', value: 'geändert' });
    } finally {
      await webhook.close();
    }
  });

  test('Teams milestone move notifications use German localized dates', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
      await expect(page.locator('#project-popover')).toBeVisible();
      await page.getByLabel('Toggle Teams notification settings').check();
      await page.locator('#project-popover input[name=teams_webhook_url]').fill(webhook.url);
      await page.locator('#project-popover button[type=submit]').click();
      await expect(page.locator('#project-popover')).toHaveCount(0);

      const milestone = page.locator('.chart-row.proj .milestone').first();
      await milestone.scrollIntoViewIfNeeded();
      const milestoneId = await milestone.getAttribute('data-milestone-id');
      const oldDate = await milestone.getAttribute('data-date');
      const box = await milestone.boundingBox();
      const ppd = parseFloat(await page.locator('#grid-scroll').evaluate(el => el.dataset.pxPerDay));

      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + ppd * 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();

      await page.waitForFunction(
        ([id, before]) => {
          const el = document.querySelector(`#ms-${id}`);
          return el && el.dataset.date !== before;
        },
        [milestoneId, oldDate],
        { timeout: 5000 }
      );

      await expect.poll(() => webhook.requests.length).toBe(1);
      const newDate = await page.locator(`#ms-${milestoneId}`).getAttribute('data-date');
      const card = webhook.requests[0].json.attachments[0].content;
      expect(card.body[0].text).toBe('Meilenstein v2 API beta verschoben');
      expect(card.body[2].text)
        .toContain(`demo hat das Datum ${germanDateShift(oldDate, newDate)} verschoben.`);
      expect(card.body[3].facts).toContainEqual({
        title: 'Datum',
        value: `${germanDate(oldDate)} → ${germanDate(newDate)}`,
      });
    } finally {
      await webhook.close();
    }
  });

  test('PM can delete a project from the sidebar', async ({ appPage: page }) => {
    await page.locator('.left-cell.proj', { hasText: 'Infra hardening' }).click();
    await expect(page.locator('#project-popover')).toBeVisible();

    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Delete project');
      await dialog.accept();
    });
    await page.locator('#project-popover button', { hasText: 'Delete project' }).click();

    await expect(page.locator('#project-popover')).toHaveCount(0);
    await expect(page.locator('.left-cell.proj')).toHaveCount(2);
    await expect(page.locator('.left-cell.proj', { hasText: 'Infra hardening' })).toHaveCount(0);
  });

  test('People page lists seeded team and accepts an Add', async ({ appPage: page }) => {
    await page.locator('.drawer-side .menu a', { hasText: 'People' }).click();
    await page.waitForURL('**/people/');
    await expect(page.locator('#people-page')).toBeVisible();
    // Demo seeds Alex / Sam / Riley
    await expect(page.locator('.person-row')).toHaveCount(3);
    await page.fill('.add-person-form input[name=name]', 'Jamie Park');
    await page.click('.add-person-form button[type=submit]');
    await expect(page.locator('.person-row')).toHaveCount(4);
  });

  test('People page keeps linked member name fields usable at a narrow viewport', async ({ appPage: page }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto('/people/');

    const alexRow = page.locator('.person-row').filter({ has: page.locator('input[name=name][value="Alex Chen"]') });
    const nameBox = await alexRow.locator('input[name=name]').boundingBox();
    const actionsBox = await alexRow.locator('.person-actions').boundingBox();
    expect(nameBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(nameBox.width).toBeGreaterThanOrEqual(200);
    expect(actionsBox.y).toBeGreaterThan(nameBox.y);
  });

  test('PM can promote and demote a linked workspace member', async ({ appPage: page }) => {
    await page.locator('.drawer-side .menu a', { hasText: 'People' }).click();
    await page.waitForURL('**/people/');

    const alexRow = page.locator('.person-row').filter({ has: page.locator('input[name=name][value="Alex Chen"]') });
    await expect(alexRow.locator('.person-role')).toHaveText('Member');

    await alexRow.getByRole('button', { name: 'Promote to manager' }).click();
    await expect(alexRow.locator('.person-role')).toHaveText('Manager');
    await expect(alexRow.getByRole('button', { name: 'Demote to member' })).toBeVisible();

    await alexRow.getByRole('button', { name: 'Demote to member' }).click();
    await expect(alexRow.locator('.person-role')).toHaveText('Member');
    await expect(alexRow.getByRole('button', { name: 'Promote to manager' })).toBeVisible();
  });

  test('People page aligns the add-team form with editable team rows', async ({ appPage: page }) => {
    await page.locator('.drawer-side .menu a', { hasText: 'People' }).click();
    await page.waitForURL('**/people/');

    const firstTeamInput = page.locator('#teams-list .team-row').first().locator('input[name=name]');
    const addTeamInput = page.locator('.add-team-form input[name=name]');
    const firstTeamBox = await firstTeamInput.boundingBox();
    const addTeamBox = await addTeamInput.boundingBox();
    expect(firstTeamBox).not.toBeNull();
    expect(addTeamBox).not.toBeNull();
    expect(Math.abs(firstTeamBox.x - addTeamBox.x)).toBeLessThanOrEqual(1);

    const rows = page.locator('#teams-list .team-row');
    const firstRowBox = await rows.nth(0).boundingBox();
    const secondRowBox = await rows.nth(1).boundingBox();
    const lastRowBox = await rows.last().boundingBox();
    const addFormBox = await page.locator('.add-team-form').boundingBox();
    expect(firstRowBox).not.toBeNull();
    expect(secondRowBox).not.toBeNull();
    expect(lastRowBox).not.toBeNull();
    expect(addFormBox).not.toBeNull();
    const rowGap = Math.round(secondRowBox.y - firstRowBox.y - firstRowBox.height);
    const addFormGap = Math.round(addFormBox.y - lastRowBox.y - lastRowBox.height);
    expect(addFormGap).toBe(rowGap);
  });

  test('People page keeps add-team choices behind a plus pill popup', async ({ appPage: page }) => {
    await page.locator('.drawer-side .menu a', { hasText: 'People' }).click();
    await page.waitForURL('**/people/');

    const alexRow = page.locator('.person-row').filter({ has: page.locator('input[name=name][value="Alex Chen"]') });
    await expect(alexRow.locator('.person-team-add-option')).toBeHidden();
    await expect(alexRow.locator('select[name=team_ids]')).toHaveCount(0);
    await expect(alexRow.locator('.person-teams-popup summary svg')).toHaveCount(1);
    await expect(alexRow.locator('.person-teams-popup summary')).toHaveClass(/rounded-full/);
    await expect(alexRow.locator('.person-teams-popup', { hasText: 'Edit teams' })).toHaveCount(0);
    await alexRow.locator('.person-teams-popup summary').click();
    await expect(alexRow.locator('.person-team-add-option')).toHaveText(['Design']);
  });

  test('People page team popup directly adds available teams only', async ({ appPage: page }) => {
    await page.locator('.drawer-side .menu a', { hasText: 'People' }).click();
    await page.waitForURL('**/people/');

    const alexRow = page.locator('.person-row').filter({ has: page.locator('input[name=name][value="Alex Chen"]') });
    await expect(alexRow.locator('.team-badge > span')).toHaveText(['Backend', 'Infrastructure']);
    await alexRow.locator('.person-teams-popup summary').click();
    const options = alexRow.locator('.person-team-add-option');
    await expect(options).toHaveText(['Design']);
    await options.getByText('Design').click();
    await expect(alexRow.locator('.team-badge > span')).toHaveText(['Backend', 'Design', 'Infrastructure']);
  });

  test('People page removes a person from a team via the team pill remove button', async ({ appPage: page }) => {
    await page.locator('.drawer-side .menu a', { hasText: 'People' }).click();
    await page.waitForURL('**/people/');

    const alexRow = page.locator('.person-row').filter({ has: page.locator('input[name=name][value="Alex Chen"]') });
    await expect(alexRow.locator('.team-badge > span')).toHaveText(['Backend', 'Infrastructure']);
    await expect(alexRow.locator('.team-badge', { hasText: 'Infrastructure' }).locator('.person-team-remove svg')).toHaveCount(1);
    page.once('dialog', dialog => dialog.accept());
    await alexRow.locator('.team-badge', { hasText: 'Infrastructure' }).locator('.person-team-remove').click();
    await expect(alexRow.locator('.team-badge > span')).toHaveText(['Backend']);
  });

  test('People page manages teams and assigns multiple teams to a person', async ({ appPage: page }) => {
    await page.locator('.drawer-side .menu a', { hasText: 'People' }).click();
    await page.waitForURL('**/people/');

    await expect(page.locator('#teams-list .team-row')).toHaveCount(3);
    await expect(page.locator('#teams-list input[value="Backend"]')).toHaveCount(1);
    await expect(page.locator('#teams-list input[value="Infrastructure"]')).toHaveCount(1);

    // Team names are unique within the workspace (case-insensitive).
    await page.fill('.add-team-form input[name=name]', 'backend');
    await page.click('.add-team-form button[type=submit]');
    await expect(page.locator('#teams-list .team-row')).toHaveCount(3);

    await page.fill('.add-team-form input[name=name]', 'QA');
    await page.click('.add-team-form button[type=submit]');
    await expect(page.locator('#teams-list .team-row')).toHaveCount(4);
    await expect(page.locator('.add-team-form input[name=name]')).toHaveValue('');

    const qaInput = page.locator('#teams-list input[value="QA"]');
    await qaInput.fill('Quality');
    await qaInput.evaluate(el => el.blur());
    await expect(page.locator('#teams-list input[value="Quality"]')).toHaveCount(1);

    const alexRow = page.locator('.person-row').filter({ has: page.locator('input[name=name][value="Alex Chen"]') });
    await alexRow.locator('.person-teams-popup summary').click();
    await expect(alexRow.locator('.person-team-add-option', { hasText: 'Quality' })).toBeVisible();
    await alexRow.locator('.person-team-add-option', { hasText: 'Quality' }).click();
    await expect(alexRow.locator('.team-badge > span')).toHaveText(['Backend', 'Infrastructure', 'Quality']);

    page.once('dialog', dialog => dialog.accept());
    await page.locator('#teams-list .team-row').filter({ has: page.locator('input[value="Quality"]') })
      .locator('.team-actions button').click();
    await expect(page.locator('#teams-list .team-row')).toHaveCount(3);
    await expect(alexRow.locator('.team-badge > span')).toHaveText(['Backend', 'Infrastructure']);
  });
});


// =============================================================================
// Workspace isolation
// =============================================================================
test.describe('workspace isolation', () => {
  test('a second PM sees an empty chart, not the demo data', async ({ page, request }) => {
    await reset(request);

    // Log in as pm2 — a second user seeded with their own empty workspace
    await page.goto('/accounts/login/');
    await page.fill('input[name=username]', 'pm2');
    await page.fill('input[name=password]', 'pm2');
    await page.click('button[type=submit]');
    await page.waitForURL('/');

    // pm2's workspace has no projects, so the chart should be empty
    await expect(page.locator('.left-cell.proj')).toHaveCount(0);
    await expect(page.locator('.bar')).toHaveCount(0);
  });

  test('topbar shows the current workspace name', async ({ appPage: page }) => {
    await expect(page.locator('#workspace-name')).toHaveText("demo's workspace");
  });

  test('user in two workspaces can switch between them', async ({ page, request }) => {
    await reset(request);

    // member1 is in demo's workspace. Add member1 to pm2's workspace too
    // by using the seeded multi-workspace user "multi1"
    await page.goto('/accounts/login/');
    await page.fill('input[name=username]', 'multi1');
    await page.fill('input[name=password]', 'multi1');
    await page.click('button[type=submit]');
    await page.waitForURL('/');

    // Should see demo's workspace data (auto-selected as first)
    await expect(page.locator('#workspace-name')).toBeVisible();

    // Open workspace switcher and pick the other workspace
    await page.locator('.ws-chevron-btn').click();
    await expect(page.locator('#workspace-menu')).toBeVisible();
    // Two workspaces listed (excluding the create form)
    await expect(page.locator('#workspace-menu .workspace-item')).toHaveCount(2);

    // Click the second workspace (pm2's)
    await page.locator('#workspace-menu .workspace-item', { hasText: "pm2's workspace" }).click();
    await page.waitForURL('/');
    // Chart should now be empty (pm2's workspace has no projects)
    await expect(page.locator('.left-cell.proj')).toHaveCount(0);
    await expect(page.locator('#workspace-name')).toHaveText("pm2's workspace");
  });

  test('user can create a new workspace from the switcher', async ({ appPage: page }) => {
    // demo starts with one workspace — no dropdown yet, just the name
    await expect(page.locator('#workspace-name')).toHaveText("demo's workspace");

    // Click the chevron to open the switcher
    await page.locator('.ws-chevron-btn').click();
    await expect(page.locator('#workspace-menu')).toBeVisible();

    // Type the name into the "Create workspace" input and press Enter
    await page.fill('#workspace-create-name', 'Side project');
    await page.locator('#workspace-create-name').press('Enter');
    await page.waitForURL('/');

    // Now in the new empty workspace
    await expect(page.locator('#workspace-name')).toHaveText('Side project');
    await expect(page.locator('.left-cell.proj')).toHaveCount(0);
  });

  test('PM can rename the current workspace from the switcher', async ({ appPage: page }) => {
    await expect(page.locator('#workspace-name')).toHaveText("demo's workspace");

    await page.locator('.ws-chevron-btn').click();
    await expect(page.locator('#workspace-menu')).toBeVisible();

    await page.fill('#workspace-rename-name', 'Roadmap HQ');
    await page.locator('#workspace-rename-name').press('Enter');
    await page.waitForURL('/');

    await expect(page.locator('#workspace-name')).toHaveText('Roadmap HQ');

    await page.locator('.ws-chevron-btn').click();
    await expect(page.locator('#workspace-menu .workspace-item.active')).toContainText('Roadmap HQ');
  });

  test('PM can enable and revoke a public roadmap generated from milestones', async ({ appPage: page, request }) => {
    await page.locator('.ws-chevron-btn').click();
    await expect(page.locator('#workspace-menu')).toBeVisible();
    await expect(page.locator('#public-roadmap-link')).toHaveCount(0);

    await page.getByRole('button', { name: 'Enable public roadmap' }).click();
    await page.waitForURL('/');

    await page.locator('.ws-chevron-btn').click();
    const href = await page.locator('#public-roadmap-link').getAttribute('href');
    expect(href).toMatch(/^\/roadmap\/[\w-]+\/$/);

    const publicResponse = await request.get(href);
    expect(publicResponse.status()).toBe(200);
    const body = await publicResponse.text();
    expect(body).toContain('demo&#x27;s workspace Roadmap');
    expect(body).toContain('API Migration');
    expect(body).toContain('v2 API beta');
    expect(body).toContain('Soft launch');
    expect(body).toContain('in 3 weeks');
    expect(body).not.toContain('Already shipped checkpoint');
    expect(body).not.toContain('Migrate /users endpoints');
    expect(body).not.toContain('Alex Chen');

    await page.getByRole('button', { name: 'Disable public roadmap' }).click();
    await page.waitForURL('/');
    const revoked = await request.get(href);
    expect(revoked.status()).toBe(404);
  });

  test('public roadmap filters milestones by project and switches grouped/timeline views', async ({ appPage: page }) => {
    await page.locator('.ws-chevron-btn').click();
    await page.getByRole('button', { name: 'Enable public roadmap' }).click();
    await page.waitForURL('/');

    await page.locator('.ws-chevron-btn').click();
    const href = await page.locator('#public-roadmap-link').getAttribute('href');
    await page.goto(href);

    const filters = page.locator('#roadmap-project-filter');
    await expect(filters.getByRole('button', { name: /API Migration/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(filters.locator('[data-project-filter]')).toHaveCount(3);
    await expect(filters).toContainText('Move public API traffic to the new v2 platform.');

    await filters.getByRole('button', { name: 'Deselect all' }).click();
    await expect(filters.locator('[data-project-filter][aria-pressed="true"]')).toHaveCount(0);
    await expect(page.locator('.roadmap-milestone-card:visible')).toHaveCount(0);
    await expect(page.locator('[data-roadmap-empty]')).toBeVisible();
    await expect(filters.getByRole('button', { name: 'Select all' })).toBeVisible();

    await filters.getByRole('button', { name: 'Select all' }).click();
    await expect(filters.locator('[data-project-filter][aria-pressed="true"]')).toHaveCount(3);
    await expect(filters.getByRole('button', { name: 'Deselect all' })).toBeVisible();

    await expect(page.getByRole('tabpanel', { name: 'Grouped' })).toBeVisible();
    await expect(page.locator('.roadmap-group:visible')).toHaveCount(2);
    await expect(page.locator('.roadmap-milestone-card:visible', { hasText: 'v2 API beta' })).toBeVisible();
    await expect(page.locator('.roadmap-milestone-card:visible', { hasText: 'Soft launch' })).toBeVisible();

    await filters.getByRole('button', { name: /API Migration/ }).click();
    await expect(filters.getByRole('button', { name: /API Migration/ })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.roadmap-milestone-card:visible', { hasText: 'v2 API beta' })).toHaveCount(0);
    await expect(page.locator('.roadmap-milestone-card:visible', { hasText: 'Soft launch' })).toBeVisible();

    await page.getByRole('tab', { name: 'Timeline' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Timeline' })).toBeVisible();
    await expect(page.locator('.roadmap-timeline-card:visible')).toHaveCount(1);
    await expect(page.locator('.roadmap-timeline-card:visible')).toContainText('Onboarding revamp');

    await filters.getByRole('button', { name: /API Migration/ }).click();
    await expect(page.locator('.roadmap-timeline-card:visible')).toHaveCount(2);
  });

  test('regenerating the public roadmap link revokes the old URL', async ({ appPage: page, request }) => {
    await page.locator('.ws-chevron-btn').click();
    await page.getByRole('button', { name: 'Enable public roadmap' }).click();
    await page.waitForURL('/');

    await page.locator('.ws-chevron-btn').click();
    const oldHref = await page.locator('#public-roadmap-link').getAttribute('href');
    await page.getByRole('button', { name: 'Regenerate public link' }).click();
    await page.waitForURL('/');

    await page.locator('.ws-chevron-btn').click();
    const newHref = await page.locator('#public-roadmap-link').getAttribute('href');
    expect(newHref).toMatch(/^\/roadmap\/[\w-]+\/$/);
    expect(newHref).not.toBe(oldHref);
    expect((await request.get(oldHref)).status()).toBe(404);
    expect((await request.get(newHref)).status()).toBe(200);
  });

  test('PM can move a project to another workspace after confirmation', async ({ appPage: page }) => {
    // Create a second workspace owned by demo; creation switches into it.
    await page.locator('.ws-chevron-btn').click();
    await page.fill('#workspace-create-name', 'Side project');
    await page.locator('#workspace-create-name').press('Enter');
    await page.waitForURL('/');
    await expect(page.locator('#workspace-name')).toHaveText('Side project');
    await expect(page.locator('.left-cell.proj')).toHaveCount(0);

    // Switch back to the seeded workspace and open the project editor.
    await page.locator('.ws-chevron-btn').click();
    await page.locator('#workspace-menu .workspace-item', { hasText: "demo's workspace" }).click();
    await page.waitForURL('/');
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toBeVisible();

    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await page.waitForSelector('#project-popover');
    await expect(page.locator('#project-move-workspace')).toBeVisible();
    await page.selectOption('#project-move-workspace', { label: 'Side project' });

    // Cancel keeps the project in the current workspace.
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Move project');
      await dialog.dismiss();
    });
    await page.click('#pp-move-workspace');
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toBeVisible();

    // Accept moves the project and patches it out of the source chart.
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Move project');
      await dialog.accept();
    });
    await page.click('#pp-move-workspace');
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toHaveCount(0);
    await expect(page.locator('.left-cell.proj')).toHaveCount(2);
    // The old API → Onboarding cross-project dependency is removed at the workspace boundary.
    await expect(page.locator('#arrows .hit')).toHaveCount(3);

    // The destination workspace now contains the moved project with its tasks and milestone.
    await page.locator('.ws-chevron-btn').click();
    await page.locator('#workspace-menu .workspace-item', { hasText: 'Side project' }).click();
    await page.waitForURL('/');
    await expect(page.locator('#workspace-name')).toHaveText('Side project');
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toBeVisible();
    await expect(page.locator('.bar', { hasText: 'Spike on auth changes' })).toBeVisible();
    await expect(page.locator('.chart-row.proj .milestone-label', { hasText: 'v2 API beta' })).toBeVisible();
    await expect(page.locator('#arrows .hit')).toHaveCount(2);
  });
});


// =============================================================================
// Member role
// =============================================================================
test.describe('member role', () => {
  async function loginAsMember(page) {
    await page.goto('/accounts/login/');
    await page.fill('input[name=username]', 'member1');
    await page.fill('input[name=password]', 'member1');
    await page.click('button[type=submit]');
    await page.waitForURL('/');
  }

  test('member sees the full chart and can create projects', async ({ page, request }) => {
    await reset(request);
    await loginAsMember(page);

    // Member sees demo's projects and tasks
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);
    await expect(page.locator('.bar')).toHaveCount(8);

    // Members can add projects.
    await expect(page.locator('.add-project-row')).toHaveCount(2);
    await page.locator('.add-project-row').last().click();
    await expect(page.locator('.left-cell.proj')).toHaveCount(4);
    await expect(page.locator('.left-cell.proj', { hasText: 'New project' })).toBeVisible();
  });

  test('member cannot promote a workspace member', async ({ page, request }) => {
    await reset(request);
    await loginAsMember(page);
    await page.goto('/people/');

    const alexRow = page.locator('.person-row', { hasText: 'Alex Chen' });
    await expect(alexRow.locator('.person-role')).toHaveText('Member');
    await expect(alexRow.getByRole('button', { name: 'Promote to manager' })).toHaveCount(0);

    const personId = (await alexRow.getAttribute('id')).replace('person-row-', '');
    const status = await page.evaluate(async (id) => {
      const token = document.cookie.split('; ').find((row) => row.startsWith('csrftoken='))?.split('=')[1] || '';
      const body = new URLSearchParams({ role: 'pm' });
      const response = await fetch(`/people/${id}/role/`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': decodeURIComponent(token),
        },
        body,
      });
      return response.status;
    }, personId);
    expect(status).toBe(403);
  });

  test('member cannot delete a project', async ({ page, request }) => {
    await reset(request);
    await loginAsMember(page);

    const project = page.locator('.left-cell.proj', { hasText: 'API Migration' });
    const projectId = await project.getAttribute('data-project-id');
    await project.click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await expect(page.locator('#project-popover button', { hasText: 'Delete project' })).toHaveCount(0);

    const status = await page.evaluate(async (id) => {
      const token = document.cookie.split('; ').find((row) => row.startsWith('csrftoken='))?.split('=')[1] || '';
      const response = await fetch(`/projects/${id}/delete/`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRFToken': decodeURIComponent(token) },
      });
      return response.status;
    }, projectId);
    expect(status).toBe(403);
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toBeVisible();
  });

  test('member can update a task assigned to them', async ({ page, request }) => {
    await reset(request);
    await loginAsMember(page);

    // member1 is linked to Alex Chen, who is assigned to "Migrate /users endpoints"
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    await expect(page.locator('#task-popover')).toBeVisible();

    // Member can edit the title
    await page.fill('#task-popover input[name=title]', 'Migrate users (updated by member)');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('#task-popover')).toHaveCount(0);
    await expect(page.locator('.bar', { hasText: 'Migrate users (updated by member)' })).toBeVisible();
  });

  test('member can update an unassigned task', async ({ page, request }) => {
    await reset(request);
    await loginAsMember(page);

    const barsBefore = await page.locator('.bar').count();
    const project = page.locator('.project-group').first();
    const sidebar = await project.locator('.left-cell.proj').boundingBox();
    const chartX = sidebar.x + sidebar.width + 20;
    await project.getByRole('button', { name: 'Add task' }).click();
    const row = project.locator('.task-creation-timeline');
    const rowBox = await row.boundingBox();
    await page.mouse.move(chartX, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(chartX + 120, rowBox.y + rowBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.bar')).toHaveCount(barsBefore + 1);

    const newTask = page.locator('.bar', { hasText: 'New task' });
    await newTask.click();
    await expect(page.locator('#task-popover')).toBeVisible();
    await expect(page.locator('#task-popover button[type=submit]')).toBeVisible();
    await expect(page.locator('#task-popover button', { hasText: 'Delete' })).toBeVisible();

    await page.fill('#task-popover input[name=title]', 'Unassigned task updated by member');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('#task-popover')).toHaveCount(0);
    await expect(page.locator('.bar', { hasText: 'Unassigned task updated by member' })).toBeVisible();
  });

  test('member cannot update a task not assigned to them', async ({ page, request }) => {
    await reset(request);
    await loginAsMember(page);

    // "User research interviews" is assigned to Riley, not Alex (member1).
    // Click forcefully: dependency-arrow hit areas can cross this bar at some
    // date geometries, but the permission assertion is about the opened drawer.
    const bar = page.locator('.bar', { hasText: 'User research interviews' });
    await bar.click({ force: true });
    await expect(page.locator('#task-popover')).toBeVisible();

    // The save button should be hidden for non-assigned tasks
    await expect(page.locator('#task-popover button[type=submit]')).toHaveCount(0);
  });
});



// =============================================================================
// App sidebar
// =============================================================================
test.describe('app sidebar', () => {
  test('sidebar shows brand, nav links, workspace name, and user area', async ({ appPage: page }) => {
    const sidebar = page.locator('.drawer-side');
    await expect(sidebar).toBeVisible();

    // Brand
    await expect(sidebar.locator('.sidebar-brand')).toHaveText('nano-pm');

    // Nav links — Projects, Resources, People
    const nav = sidebar.locator('.menu');
    await expect(nav.locator('a', { hasText: 'Projects' })).toBeVisible();
    await expect(nav.locator('a', { hasText: 'Resources' })).toBeVisible();
    await expect(nav.locator('a', { hasText: 'People' })).toBeVisible();
    await expect(nav.locator('a', { hasText: 'Projects' })).toHaveCSS('font-size', '16px');
    await expect(sidebar.getByRole('button', { name: 'Switch to dark mode' })).toHaveCSS('font-size', '16px');
    await expect(sidebar.locator('#workspace-name')).toHaveCSS('font-size', '16px');
    await expect(sidebar.locator('.lang-btn', { hasText: 'EN' })).toHaveCSS('font-size', '16px');

    await sidebar.getByRole('button', { name: 'Switch workspace' }).click();
    const workspaceMenu = page.locator('#workspace-menu');
    await expect(workspaceMenu.locator('.workspace-menu-header').first()).toHaveCSS('font-size', '16px');
    await expect(workspaceMenu.locator('.workspace-item').first()).toHaveCSS('font-size', '16px');
    await expect(workspaceMenu.locator('#workspace-rename-name')).toHaveCSS('font-size', '16px');
    await expect(workspaceMenu.locator('#workspace-create-name')).toHaveCSS('font-size', '16px');
    await expect(workspaceMenu.getByRole('button', { name: 'Rename' })).toHaveCSS('font-size', '16px');
    await expect(workspaceMenu.locator('p').first()).toHaveCSS('font-size', '16px');

    // Projects link is active on the main page
    await expect(nav.locator('a', { hasText: 'Projects' })).toHaveClass(/menu-active/);

    // Workspace name visible in sidebar
    await expect(sidebar.locator('#workspace-name')).toHaveText("demo's workspace");

    // User area
    await expect(sidebar.locator('.sidebar-user')).toContainText('demo');
  });

  test('sidebar nav links navigate between views', async ({ appPage: page }) => {
    const nav = page.locator('.drawer-side .menu');

    // Click Resources
    await nav.locator('a', { hasText: 'Resources' }).click();
    await page.waitForURL('**/resources/');
    await expect(nav.locator('a', { hasText: 'Resources' })).toHaveClass(/menu-active/);

    // Click back to Projects
    await nav.locator('a', { hasText: 'Projects' }).click();
    await page.waitForURL(/\/$/);
    await expect(nav.locator('a', { hasText: 'Projects' })).toHaveClass(/menu-active/);
  });

  test('sidebar nav People link opens the people page', async ({ appPage: page }) => {
    await page.locator('.drawer-side .menu a', { hasText: 'People' }).click();
    await page.waitForURL('**/people/');
    await expect(page.locator('#people-page')).toBeVisible();
    await expect(page.locator('.drawer-side .menu a', { hasText: 'People' })).toHaveClass(/menu-active/);
  });
});


// =============================================================================
// Per-person invitation
// =============================================================================
test.describe('per-person invitation', () => {
  test('PM can generate an invite link for an unlinked person and a new user can join through it', async ({ appPage: page, browser }) => {
    // Navigate to People page
    await page.locator('.drawer-side .menu a', { hasText: 'People' }).click();
    await page.waitForURL('**/people/');

    // Sam Patel is seeded without a linked user — should have an Invite button
    const samRow = page.locator('.person-row').filter({ has: page.locator('input[value="Sam Patel"]') });
    await expect(samRow).toBeVisible();
    const inviteBtn = samRow.locator('button', { hasText: 'Invite' });
    await expect(inviteBtn).toBeVisible();

    // Click Invite — should reveal an invite link
    await inviteBtn.click();
    const linkInput = page.locator('#invite-link-slot input[readonly]');
    await expect(linkInput).toBeVisible();
    const inviteUrl = await linkInput.inputValue();
    expect(inviteUrl).toContain('/invite/');

    // New user visits the invite link in a fresh browser context
    const newCtx = await browser.newContext();
    const newPage = await newCtx.newPage();
    await newPage.goto(inviteUrl);

    // Signup form shows workspace and person context
    await expect(newPage.locator('input[name=username]')).toBeVisible();

    // Sign up
    await newPage.fill('input[name=username]', 'sampatel');
    await newPage.fill('input[name=password]', 'sampatel123');
    await newPage.click('button[type=submit]');
    await newPage.waitForURL('**/');

    // New user lands in the workspace
    await expect(newPage.locator('#workspace-name')).toHaveText("demo's workspace");

    // Go to People page — Sam Patel should now be linked
    await newPage.locator('.drawer-side .menu a', { hasText: 'People' }).click();
    await newPage.waitForURL('**/people/');
    const samLinked = newPage.locator('.person-row', { hasText: 'Sam Patel' });
    await expect(samLinked.locator('.person-username')).toContainText('sampatel');

    await newCtx.close();
  });
});

// =============================================================================
// Removed board view
// =============================================================================
test.describe('removed board view', () => {
  test('sidebar no longer links to a task board', async ({ appPage: page }) => {
    const nav = page.locator('.drawer-side .menu');
    await expect(nav.locator('a', { hasText: 'Tasks' })).toHaveCount(0);
  });

  test('the former task board URL is gone', async ({ appPage: page }) => {
    const response = await page.goto('/tasks/');
    expect(response.status()).toBe(404);
  });
});

// =============================================================================
// i18n — German translations
// =============================================================================
test.describe('i18n (German)', () => {
  test('defaults to English in the sidebar nav', async ({ appPage: page }) => {
    const nav = page.locator('.drawer-side .menu');
    await expect(nav.locator('a', { hasText: 'Projects' })).toBeVisible();
    await expect(nav.locator('a', { hasText: 'Resources' })).toBeVisible();
    // EN is the active language button.
    await expect(page.locator('.lang-btn', { hasText: 'EN' })).toHaveClass(/active/);
  });

  test('the DE switcher translates the sidebar nav, and EN switches back', async ({ appPage: page }) => {
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    const nav = page.locator('.drawer-side .menu');
    await expect(nav.locator('a', { hasText: 'Projekte' })).toBeVisible();
    await expect(nav.locator('a', { hasText: 'Ressourcen' })).toBeVisible();
    await expect(nav.locator('a', { hasText: 'Personen' })).toBeVisible();
    await expect(page.locator('.sign-out-btn')).toHaveText('Abmelden');
    await expect(page.locator('.lang-btn', { hasText: 'DE' })).toHaveClass(/active/);
    const sortButton = page.locator('#project-sort-toggle');
    await expect(sortButton.locator('.sort-label-inactive')).toHaveText('Reihenfolge anpassen');
    await expect(sortButton.locator('.sort-label-inactive')).toBeVisible();
    await sortButton.click();
    await expect(sortButton.locator('.sort-label-active')).toHaveText('Sortieren beenden');
    await expect(sortButton.locator('.sort-label-active')).toBeVisible();

    // The choice persists across navigation (language cookie / session).
    await page.goto('/people/');
    await expect(page.locator('.people-page-header h1')).toHaveText('Personen');

    // Switch back to English.
    await page.locator('.lang-btn', { hasText: 'EN' }).click();
    await expect(page.locator('.drawer-side .menu a', { hasText: 'Projects' })).toBeVisible();
  });

  test('day zoom axis labels are translated', async ({ appPage: page }) => {
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    await expect(page.locator('.drawer-side .menu a', { hasText: 'Projekte' })).toBeVisible();
    await page.goto('/?zoom=day');

    const labels = await page.locator('#time-axis .axis-day-name').evaluateAll(days =>
      days.map(day => day.textContent?.trim()),
    );
    expect(labels).toEqual(expect.arrayContaining(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']));
    await expect(page.locator('#time-axis .axis-week').first()).toContainText('KW');
  });

  test('today line position remains valid in German locale', async ({ appPage: page }) => {
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    await expect(page.locator('#today-line')).toBeVisible();

    const left = await page.locator('#today-line').evaluate(el => el.style.left);
    expect(left).toMatch(/^\d+(?:\.\d+)?px$/);
  });

  test('resource view collapse toggle is translated', async ({ appPage: page }) => {
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    await page.goto('/resources/');

    const button = page.locator('#collapse-all-btn');
    await expect(button).toHaveText('Alle einklappen');
    await button.click();
    await expect(button).toHaveText('Alle ausklappen');
  });

  test('task popover labels are translated', async ({ appPage: page }) => {
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    await expect(page.locator('.drawer-side .menu a', { hasText: 'Projekte' })).toBeVisible();

    // Open a task popover and check translated field labels.
    await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).click();
    const pop = page.locator('#task-popover');
    await expect(pop).toBeVisible();
    await expect(pop.locator('label', { hasText: 'Titel' })).toBeVisible();
    await expect(pop.locator('label', { hasText: 'Beschreibung' })).toBeVisible();
    await expect(pop.locator('select[name=status]')).toHaveCount(0);
  });

  test('honors the Accept-Language header without an explicit switch', async ({ browser, request }) => {
    await reset(request);
    const ctx = await browser.newContext({ locale: 'de-DE' });
    const page = await ctx.newPage();
    // Log in fresh in this German-locale context.
    await page.goto('/accounts/login/');
    await expect(page.locator('.login-card .hint').first()).toHaveText('Melden Sie sich bei Ihren Projekten an.');
    await page.fill('input[name=username]', 'demo');
    await page.fill('input[name=password]', 'demo');
    await page.click('button[type=submit]');
    await page.waitForURL('/');
    await expect(page.locator('.drawer-side .menu a', { hasText: 'Personen' })).toBeVisible();
    await ctx.close();
  });
});

// =============================================================================
// Project completion (manual status flag + show-completed filter)
// =============================================================================
test.describe('project completion', () => {
  test('marking a project complete hides it from the chart by default', async ({ appPage: page }) => {
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);

    // Open the project popover and mark it complete.
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await page.waitForSelector('#project-popover');
    await page.click('#pp-toggle-complete');

    // Completed projects are hidden by default → the row disappears.
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toHaveCount(0);
    await expect(page.locator('.left-cell.proj')).toHaveCount(2);
  });

  test('the show-completed toggle reveals completed projects at the bottom, dimmed', async ({ appPage: page }) => {
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await page.waitForSelector('#project-popover');
    await page.click('#pp-toggle-complete');
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toHaveCount(0);

    // Flip the topbar filter on.
    await page.click('#show-completed-toggle');

    const proj = page.locator('.left-cell.proj', { hasText: 'API Migration' });
    await expect(proj).toHaveCount(1);
    await expect(proj).toHaveClass(/completed/);
    await expect(page.locator('.left-cell.proj')).toHaveText([
      /Onboarding revamp/,
      /Infra hardening/,
      /API Migration/,
    ]);
  });

  test('completion controls are translated (de)', async ({ appPage: page }) => {
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    await expect(page.locator('#show-completed-toggle')).toHaveText(/Erledigte anzeigen/);

    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await page.waitForSelector('#project-popover');
    await expect(page.locator('#pp-toggle-complete')).toHaveText(/Als erledigt markieren/);
  });

  test('reopening a completed project keeps it visible with the filter off', async ({ appPage: page }) => {
    // Complete it.
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await page.waitForSelector('#project-popover');
    await page.click('#pp-toggle-complete');
    await expect(page.locator('.left-cell.proj')).toHaveCount(2);

    // Reveal completed, reopen it.
    await page.click('#show-completed-toggle');
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await page.waitForSelector('#project-popover');
    await page.click('#pp-toggle-complete');

    // Turn the filter back off — the reopened project stays because it is active.
    await page.click('#show-completed-toggle');
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);
    await expect(page.locator('.left-cell.proj.completed')).toHaveCount(0);
  });
});
