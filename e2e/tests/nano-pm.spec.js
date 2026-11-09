const http = require('http');
const { execFile } = require('child_process');
const { mkdtemp, rm } = require('fs/promises');
const { tmpdir } = require('os');
const { promisify } = require('util');
const path = require('path');
const { startServer } = require('../server');

async function notificationDB(code) {
  const { stdout } = await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'shell', '-c', `
import json
from datetime import timedelta
from django.utils import timezone
from data.models import NotificationBatch, NotificationChange, TeamsDelivery
${code}
`], { cwd: path.resolve(__dirname, '../..'), env: djangoEnv() });
  return stdout.trim().split('\n').at(-1);
}

async function ageNotificationBatches() {
  // Age only editable batches, never HTTP retry schedules. A separate process
  // also proves pending notifications survive web/worker process boundaries.
  await notificationDB("NotificationBatch.objects.filter(status='open').update(send_after=timezone.now())");
}

async function deliverTeamsNotifications({ advance = true } = {}) {
  if (advance) await ageNotificationBatches();
  await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'deliver_teams_notifications', '--once'], {
    cwd: path.resolve(__dirname, '../..'),
    env: djangoEnv(),
  });
}

async function holdSQLiteWriteLock() {
  // Exceed Django's five-second busy timeout to exercise actual cross-process contention.
  let child;
  const done = new Promise((resolve, reject) => {
    child = execFile('uv', ['run', 'python', '-u', '-c', `
import os, sqlite3, time
with sqlite3.connect(os.environ['DJANGO_DB_PATH'], timeout=10) as connection:
    connection.execute('BEGIN IMMEDIATE')
    print('locked', flush=True)
    time.sleep(7)
    connection.rollback()
`], { cwd: path.resolve(__dirname, '../..'), env: djangoEnv(), timeout: 15000 }, (error) => error ? reject(error) : resolve());
  });
  await Promise.race([
    new Promise(resolve => child.stdout.once('data', resolve)),
    done.then(() => { throw new Error('Lock process exited before acquiring the write lock'); }),
  ]);
  return { done };
}

async function configureTeams(page, url, events = ['milestone.moved', 'milestone.updated']) {
  const response = await page.goto('/workspaces/teams/');
  expect(response.status()).toBe(200);
  await page.getByRole('button', { name: 'Set up new webhook', exact: true }).click();
  await page.getByLabel('Microsoft Teams webhook URL').fill(url);
  await page.getByRole('button', { name: 'Save webhook', exact: true }).click();
  await expect(page.locator('#teams-connection-status')).toHaveText('Webhook configured');
  await expect(page.locator('#teams-webhook-dialog')).not.toBeVisible();
  for (const input of await page.locator('input[name=teams_notify_events]').all()) {
    await input.setChecked(events.includes(await input.getAttribute('value')));
  }
  await page.getByRole('button', { name: 'Save workspace notifications' }).click();
  await expect(page.getByLabel('Microsoft Teams webhook URL')).toHaveValue('');
}

async function saveTeamsIdentity(page, address) {
  await page.goto('/profile/');
  await page.getByLabel('Teams email address', { exact: true }).fill(address);
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByLabel('Teams email address', { exact: true })).toHaveValue(address.toLowerCase());
}

async function unfollowProject(project) {
  await project.getByRole('button', { name: 'Subscribed', exact: true }).click();
  await project.getByRole('button', { name: 'Unfollow', exact: true }).click();
}

async function postForm(page, url, fields) {
  return page.evaluate(async ({ url, fields }) => {
    const csrf = document.querySelector('input[name=csrfmiddlewaretoken]')?.value || document.querySelector('meta[name="csrf-token"]').content;
    const response = await fetch(url, {
      method: 'POST', headers: { 'X-CSRFToken': csrf }, body: new URLSearchParams(fields),
    });
    await response.text();
    return response.status;
  }, { url, fields });
}

async function enableRoadmap(page) {
  await page.goto('/workspaces/settings/sharing/');
  await page.getByRole('button', { name: 'Enable public roadmap' }).click();
  return page.locator('#public-roadmap-link').getAttribute('href');
}

const { test, expect, login, loginThroughUI, reset, djangoEnv } = require('./fixtures');

function germanNumericDate(iso) {
  return iso.split('-').reverse().join('.');
}

function germanDate(iso) {
  const months = [
    'Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni',
    'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.',
  ];
  const [year, month, day] = iso.split('-').map(Number);
  return `${day}. ${months[month - 1]} ${year}`;
}

function expectTeamsLayout(card, project, event, milestone) {
  expect(card.body[0]).toMatchObject({
    type: 'TextBlock', text: project, weight: 'Bolder', size: 'Medium', wrap: true,
  });
  expect(card.body[0].isSubtle).not.toBe(true);
  expect(card.body[0].color).not.toBe('Accent');
  expect(card.body[1]).toMatchObject({ text: event, isSubtle: true, spacing: 'None' });
  expect(card.body[2]).toMatchObject({ text: milestone, weight: 'Bolder', spacing: 'Medium', wrap: true });
  expect(card.body.some(block => block.type === 'FactSet')).toBe(false);
}

async function placeMilestoneGhost(page, project, offset = 140) {
  const row = project.locator('.chart-row.proj');
  await expect(row.locator('.creation-milestone-preview')).toBeVisible();
  const rowBox = await row.boundingBox();
  const sidebar = await project.locator('.left-cell.proj').boundingBox();
  await page.mouse.click(sidebar.x + sidebar.width + offset, rowBox.y + rowBox.height / 2);
  await expect(page.locator('#milestone-popover')).toBeVisible();
}

async function startWebhookServer(statuses = [200], beforeRespond = async () => {}) {
  const requests = [];
  const errors = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let json = null;
      try { json = JSON.parse(body || '{}'); } catch (_) {}
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, json });
      let status = statuses[Math.min(requests.length - 1, statuses.length - 1)];
      try { await beforeRespond(); } catch (error) { errors.push(String(error)); status = 500; }
      res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/teams-webhook`,
    requests,
    errors,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function enableWorkload(page) {
  expect((await page.goto('/workspaces/workload/')).status()).toBe(200);
  await page.getByLabel('Enable workload reporting', { exact: true }).check();
  await expect(page.locator('[data-workload-setting="workload_enabled"]')).toHaveAttribute('data-enabled', 'true');
}

async function signInAs(page, username, { keepCheckin = false } = {}) {
  await page.locator('.sign-out-btn').click();
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', username);
  await page.click('button[type=submit]');
  await page.waitForURL('/');
  // Most tests exercise other features; dismiss the initial, intentionally
  // blocking check-in just as a user continuing to their work would.
  const checkin = page.locator('#workload-checkin-dialog');
  if (!keepCheckin && await checkin.count()) {
    await expect(checkin).toHaveAttribute('data-initialized', 'true');
    if (await checkin.isVisible()) await page.keyboard.press('Escape');
  }
}

async function submitWorkloadExample(page, { maintenance = 30, meetings = 10 } = {}) {
  await page.goto('/workload/');
  await page.getByLabel('Maintenance percentage', { exact: true }).fill(String(maintenance));
  await page.getByLabel('Project work percentage', { exact: true }).fill('60');
  await page.getByLabel('Meetings percentage', { exact: true }).fill(String(meetings));
  await page.getByText('Optional project breakdown', { exact: true }).click();
  await page.locator('.workload-projects').getByLabel('Show all projects', { exact: true }).check();
  await page.locator('.workload-projects').getByRole('button', { name: 'Add API Migration', exact: true }).click();
  await page.getByLabel('Project work: API Migration percentage', { exact: true }).fill('40');
  await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
  await expect(page.locator('#workload-status')).toContainText('Estimate saved');
}

async function seedWorkloadDashboard() {
  const { stdout } = await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'shell', '-c', `
import json
from datetime import datetime
from django.utils import timezone
from data.models import Membership, Person, Team, WorkloadCategory, WorkloadReport, WorkloadAllocation
workspace = Membership.objects.get(user__username='member1').workspace
categories = list(WorkloadCategory.objects.filter(workspace=workspace).order_by('order', 'id'))
now = timezone.now()
def at_month(offset):
    year, month = divmod(now.year * 12 + now.month - 1 + offset, 12)
    return datetime(year, month + 1, 1, tzinfo=now.tzinfo)
def snapshot(username, offset, values):
    user = Membership.objects.get(workspace=workspace, user__username=username).user
    report = WorkloadReport.objects.create(workspace=workspace, user=user, user_label=username)
    WorkloadReport.objects.filter(pk=report.pk).update(reviewed_at=at_month(offset))
    for category, value in zip(categories, values):
        WorkloadAllocation.objects.create(report=report, category=category, category_label=category.name, supports_projects=category.supports_projects, percentage=value)
snapshot('member1', -5, [20, 70, 10])
for _ in range(22):
    snapshot('member1', -5, [40, 50, 10])
snapshot('ideaeditor', -4, [80, 10, 10])
snapshot('member1', -2, [60, 30, 10])
snapshot('ideaeditor', 0, [20, 80, 0])
team = Team.objects.create(workspace=workspace, name='Dashboard team')
person, _ = Person.objects.get_or_create(workspace=workspace, user__username='member1', defaults={'user': Membership.objects.get(workspace=workspace, user__username='member1').user, 'name': 'Dashboard member'})
person.teams.add(team)
print(json.dumps({'team': str(team.pk), 'ideaeditor': str(Membership.objects.get(workspace=workspace, user__username='ideaeditor').user_id)}))
`], { cwd: path.resolve(__dirname, '../..'), env: djangoEnv() });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function ageWorkloadCheckin(days = 31, snoozeDays = 0) {
  await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'shell', '-c', `
from datetime import timedelta
from django.utils import timezone
from data.models import WorkloadReport, Membership
WorkloadReport.objects.filter(user__username='member1').update(reviewed_at=timezone.now()-timedelta(days=${days}))
${snoozeDays ? `Membership.objects.filter(user__username='member1').update(workload_snoozed_until=timezone.now()-timedelta(days=${snoozeDays}))` : ''}
`], {
    cwd: path.resolve(__dirname, '../..'),
    env: djangoEnv(),
  });
}

// GitLab uses a real local API receiver, never a live GitLab account.
async function fakeGitLab() {
  const api = { issues: [], events: {}, status: 200, requests: [], groups: {}, failures: {}, omitFromList: false, retryAfter: '', redirectTo: '', beforeRequest: async () => {} };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    api.requests.push({ path: url.pathname, query: url.search, token: req.headers['private-token'] });
    await api.beforeRequest(url);
    res.setHeader('Content-Type', 'application/json');
    if (api.retryAfter) res.setHeader('Retry-After', api.retryAfter);
    if (api.redirectTo) res.setHeader('Location', api.redirectTo);
    const status = api.failures[url.pathname] || api.status;
    if (status !== 200) { res.writeHead(status); res.end('{}'); return; }
    const group = url.pathname.match(/\/groups\/(\d+)\/projects$/);
    if (group) { res.end(JSON.stringify((api.groups[group[1]] || []).map(id => ({ id })))); return; }
    const match = url.pathname.match(/\/projects\/(\d+)\/issues(?:\/(\d+)(?:\/(resource_label_events|resource_state_events))?)?$/);
    if (!match) { res.writeHead(404); res.end('{}'); return; }
    const [, project, iid, kind] = match;
    if (kind) {
      res.end(JSON.stringify(api.events[`${project}:${iid}:${kind}`] || []));
    } else if (iid) {
      const issue = api.issues.find(i => i.project_id === Number(project) && i.iid === Number(iid));
      res.writeHead(issue ? 200 : 404); res.end(JSON.stringify(issue || {}));
    } else {
      // Force pagination even for small fixtures.
      const items = api.omitFromList ? [] : api.issues.filter(i => i.project_id === Number(project));
      const page = Number(url.searchParams.get('page') || 1);
      res.setHeader('X-Next-Page', page < items.length ? String(page + 1) : '');
      res.end(JSON.stringify(items.slice(page - 1, page)));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  api.url = `http://127.0.0.1:${server.address().port}`;
  api.issue = (iid, title, extra = {}) => ({
    id: iid, iid, project_id: 101, title, labels: [], state: 'opened',
    created_at: '2025-01-01T10:00:00Z', updated_at: new Date().toISOString(),
    ...extra,
  });
  api.close = () => new Promise(resolve => server.close(resolve));
  return api;
}

async function gitlabDB(code) {
  const { stdout } = await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'shell', '-c', `
import json
from data.models import GitLabConnection, GitLabIssue, GitLabIssueEvent, Membership, Workspace, Project
${code}
`], { cwd: path.resolve(__dirname, '../..'), env: djangoEnv() });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function syncGitLab() {
  await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'sync_gitlab', '--once'], {
    cwd: path.resolve(__dirname, '../..'), env: djangoEnv(),
  });
}

async function connectGitLab(page, api) {
  const response = await page.goto('/workspaces/settings/integrations/');
  expect(response.status()).toBe(200);
  await page.getByLabel('GitLab instance URL').fill(api.url);
  await page.getByLabel('GitLab API token').fill('test-private-token');
  await page.getByLabel('GitLab project IDs').fill('101, 102');
  await page.getByRole('button', { name: 'Save GitLab connection', exact: true }).click();
  await expect(page.locator('#gitlab-connection-status')).toContainText('Connected');
}

async function bindGitLab(page, projectId, prefix) {
  await page.goto(`/projects/${projectId}/`);
  await page.getByText('GitLab project settings', { exact: true }).click();
  await page.getByLabel('GitLab title prefix').fill(prefix);
  await expect(page.locator('[data-prefix-preview]')).toHaveText(`${prefix}: …`);
  await page.getByLabel('Collect matching GitLab issues').check();
  await page.getByRole('button', { name: 'Save GitLab project settings', exact: true }).click();
  await expect(page.getByLabel('GitLab title prefix')).toHaveValue(prefix);
}

function gitlabRows(page) { return page.locator('#gitlab-issues tbody tr'); }

const mcp = require('./mcp-helpers');
const oauth = require('./oauth-helpers');

test.describe('MCP endpoint', () => {
  test('MCP OAuth discovery advertises authorization code PKCE and refresh endpoints', async ({ appPage: page, baseURL }) => {
    const unauthorized = await page.request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(unauthorized.status()).toBe(401);
    expect(unauthorized.headers()['www-authenticate']).toContain(`resource_metadata="${baseURL}/.well-known/oauth-protected-resource/mcp"`);
    const resource = await page.request.get('/.well-known/oauth-protected-resource/mcp');
    expect(resource.status()).toBe(200);
    expect((await resource.json()).authorization_servers).toEqual([`${baseURL}/oauth`]);
    const metadata = await page.request.get('/.well-known/oauth-authorization-server/oauth');
    expect(metadata.status()).toBe(200);
    expect(await metadata.json()).toMatchObject({ authorization_endpoint: `${baseURL}/oauth/authorize`, token_endpoint: `${baseURL}/oauth/token`, registration_endpoint: `${baseURL}/oauth/register`, revocation_endpoint: `${baseURL}/oauth/revoke`, code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'] });
  });

  test('MCP OAuth login and consent bind selected workspaces and scopes', async ({ appPage: page, baseURL }) => {
    const bearer = await mcp.setup(page);
    const flow = await oauth.start(page, baseURL, { scope: 'core.read core.write workspace.admin sharing.links' });
    await page.context().clearCookies();
    await page.goto(flow.url);
    await expect(page).toHaveURL(/\/accounts\/login\//);
    await page.getByLabel('Username').fill('demo');
    await page.getByLabel('Password').fill('demo');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect an assistant' })).toBeVisible();
    expect(await page.locator('input[name="workspace"]:checked').count()).toBe(0);
    await expect(page.locator('input[value="workspace.admin"]')).not.toBeChecked();
    await expect(page.locator('input[value="sharing.links"]')).not.toBeChecked();
    const callback = await oauth.decide(page, flow, { workspaces: [bearer.workspace_id], caps: ['core.read'] });
    const response = await flow.exchange(callback.get('code'));
    expect(response.status(), await response.text()).toBe(200);
    const tokens = await response.json();
    expect(tokens.scope).toBe('core.read');
    expect(response.headers()['cache-control']).toBe('no-store');
    const workspaces = await flow.call(tokens.access_token, 'list_workspaces');
    expect(workspaces.items.map(w => w.id)).toEqual([bearer.workspace_id]);
    expect((await flow.call(tokens.access_token, 'get_me')).capabilities).toEqual(['core.read']);
    const write = await flow.rpc(tokens.access_token, 'create_project', { workspace_id: bearer.workspace_id, operation_id: mcp.randomUUID(), name: 'Denied' });
    expect((await write.json()).error.message).toContain('Unknown tool');
    const foreign = await flow.rpc(tokens.access_token, 'list_projects', { workspace_id: bearer.foreign_workspace_id });
    expect(JSON.stringify(await foreign.json())).toContain('not_found');
    await mcp.db(`Membership.objects.create(user=get_user_model().objects.get(username='demo'), workspace_id=${bearer.foreign_workspace_id}, role='pm')\nprint('null')`);
    expect((await flow.call(tokens.access_token, 'list_workspaces')).items.map(w => w.id)).toEqual([bearer.workspace_id]);
    const privateData = await mcp.db("from django_mcpz.oauth.models import AccessToken, RefreshToken, AuthorizationCode\nprint(json.dumps({'access':list(AccessToken.objects.values()),'refresh':list(RefreshToken.objects.values()),'codes':list(AuthorizationCode.objects.values())},default=str))");
    expect(JSON.stringify(privateData)).not.toContain(tokens.access_token);
    expect(JSON.stringify(privateData)).not.toContain(tokens.refresh_token);
    expect(JSON.stringify(privateData)).not.toContain(callback.get('code'));
  });

  test('MCP OAuth refresh preserves consent, mutation receipts and rate state', async ({ appPage: page, baseURL }) => {
    const bearer = await mcp.setup(page);
    const flow = await oauth.start(page, baseURL);
    const callback = await oauth.decide(page, flow, { workspaces: [bearer.workspace_id] });
    const exchanged = await flow.exchange(callback.get('code'));
    expect(exchanged.status()).toBe(200);
    const original = await exchanged.json();
    const args = { workspace_id: bearer.workspace_id, operation_id: mcp.randomUUID(), name: 'OAuth-created project' };
    const created = await flow.call(original.access_token, 'create_project', args);
    const escalation = await flow.refresh(original.refresh_token, { scope: 'workspace.admin sharing.links' });
    expect(escalation.status()).toBe(400);
    expect((await escalation.json()).error).toBe('invalid_scope');
    const refreshed = await flow.refresh(original.refresh_token);
    expect(refreshed.status(), await refreshed.text()).toBe(200);
    const next = await refreshed.json();
    expect(next.access_token).not.toBe(original.access_token);
    expect(next.refresh_token).not.toBe(original.refresh_token);
    expect(next.scope.split(' ').sort()).toEqual(['core.read', 'core.write']);
    expect(await flow.call(next.access_token, 'create_project', args)).toEqual(created);
    const details = await mcp.db("print(json.dumps({'policies':MCPAccessPolicy.objects.filter(oauth_code__isnull=False).count(),'receipts':MCPMutationReceipt.objects.filter(policy__oauth_code__isnull=False).count(),'requests':MCPAccessPolicy.objects.get(oauth_code__isnull=False).rate_count}))");
    expect(details).toEqual({ policies: 1, receipts: 1, requests: 2 });
    const replay = await flow.refresh(original.refresh_token);
    expect(replay.status()).toBe(400);
    expect((await flow.rpc(next.access_token, 'get_me')).status()).toBe(401);
    expect((await flow.rpc(original.access_token, 'get_me')).status()).toBe(401);
  });

  test('MCP OAuth validates PKCE, redirect and resource binding and revokes token families', async ({ appPage: page, baseURL }) => {
    const bearer = await mcp.setup(page);
    const flow = await oauth.start(page, baseURL);
    const callback = await oauth.decide(page, flow, { workspaces: [bearer.workspace_id] });
    for (const extra of [{ code_verifier: 'x'.repeat(64) }, { redirect_uri: 'https://attacker.invalid/callback' }, { resource: `${baseURL}/other-resource` }]) {
      const invalid = await flow.exchange(callback.get('code'), extra);
      expect(invalid.status()).toBe(400);
    }
    const response = await flow.exchange(callback.get('code'));
    expect(response.status()).toBe(200);
    const tokens = await response.json();
    expect((await flow.call(tokens.access_token, 'get_me')).username).toBe('demo');
    const wrongHost = await page.request.post(`${baseURL.replace('localhost', '127.0.0.1')}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(wrongHost.status()).toBe(401);
    expect((await flow.revoke(tokens.refresh_token)).status()).toBe(200);
    expect((await flow.rpc(tokens.access_token, 'get_me')).status()).toBe(401);
    expect((await flow.refresh(tokens.refresh_token)).status()).toBe(400);
  });

  test('MCP OAuth consent rejects forged workspaces, extra scopes and missing CSRF', async ({ appPage: page, baseURL }) => {
    const bearer = await mcp.setup(page);
    const flow = await oauth.start(page, baseURL, { scope: 'core.read' });
    await page.goto(flow.url);
    const csrf = await page.locator('input[name="csrfmiddlewaretoken"]').inputValue();
    const missing = await page.request.post(flow.url, { form: { decision: 'allow', workspace: bearer.workspace_id, capability: 'core.read' }, maxRedirects: 0 });
    expect(missing.status()).toBe(403);
    for (const extra of [{ workspace: bearer.foreign_workspace_id, capability: 'core.read' }, { workspace: bearer.workspace_id, capability: 'workspace.admin' }, { capability: 'core.read' }]) {
      const bad = await page.request.post(flow.url, { form: { csrfmiddlewaretoken: csrf, decision: 'allow', ...extra }, maxRedirects: 0 });
      expect(bad.status(), await bad.text()).toBe(400);
    }
    expect(await mcp.db("from django_mcpz.oauth.models import AuthorizationCode\nprint(json.dumps(AuthorizationCode.objects.count()))")).toBe(0);
    const denied = await oauth.decide(page, flow, { decision: 'deny', caps: [] });
    expect(denied.get('error')).toBe('access_denied');
    expect(denied.has('code')).toBe(false);
  });

  test('MCP OAuth connections disconnect immediately and cannot revoke another user grant', async ({ appPage: page, baseURL }) => {
    const bearer = await mcp.setup(page);
    const flow = await oauth.start(page, baseURL);
    const callback = await oauth.decide(page, flow, { workspaces: [bearer.workspace_id] });
    const response = await flow.exchange(callback.get('code'));
    expect(response.status()).toBe(200);
    const tokens = await response.json();
    const policyId = await mcp.db("print(json.dumps(MCPAccessPolicy.objects.get(oauth_code__isnull=False).pk))");
    await page.goto('/profile/');
    await page.getByRole('link', { name: 'Assistant connections', exact: true }).click();
    await expect(page.locator(`[data-oauth-policy="${policyId}"]`)).toContainText('Test assistant');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByText('No assistant connections.', { exact: true })).toBeVisible();
    expect((await flow.rpc(tokens.access_token, 'get_me')).status()).toBe(401);
    expect((await flow.refresh(tokens.refresh_token)).status()).toBe(400);
    await page.goto('/');
    await signInAs(page, 'pm2');
    await page.goto('/accounts/mcp/');
    const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
    const foreign = await page.request.post('/accounts/mcp/', { form: { csrfmiddlewaretoken: csrf, policy_id: policyId }, maxRedirects: 0 });
    expect(foreign.status()).toBe(404);
  });

  test('MCP OAuth refresh can narrow scopes but cannot restore removed permissions', async ({ appPage: page, baseURL }) => {
    const bearer = await mcp.setup(page);
    const flow = await oauth.start(page, baseURL);
    const callback = await oauth.decide(page, flow, { workspaces: [bearer.workspace_id] });
    const original = await (await flow.exchange(callback.get('code'))).json();
    const response = await flow.refresh(original.refresh_token, { scope: 'core.read' });
    expect(response.status()).toBe(200);
    const narrowed = await response.json();
    expect(narrowed.scope).toBe('core.read');
    expect((await flow.call(narrowed.access_token, 'get_me')).capabilities).toEqual(['core.read']);
    const denied = await flow.rpc(narrowed.access_token, 'create_project', { workspace_id: bearer.workspace_id, operation_id: mcp.randomUUID(), name: 'Not permitted' });
    expect((await denied.json()).error.message).toContain('Unknown tool');
    expect((await flow.refresh(narrowed.refresh_token, { scope: 'core.read core.write' })).status()).toBe(400);
  });

  test('MCP OAuth enforces expiry, user deactivation and current membership after consent', async ({ appPage: page, baseURL }) => {
    const bearer = await mcp.setup(page);
    const flow = await oauth.start(page, baseURL, { scope: null });
    const callback = await oauth.decide(page, flow, { workspaces: [bearer.workspace_id] });
    let tokens = await (await flow.exchange(callback.get('code'))).json();
    await mcp.db("from django_mcpz.oauth.models import AccessToken\nAccessToken.objects.update(expires_at=timezone.now()-timedelta(seconds=1))\nprint('null')");
    expect((await flow.rpc(tokens.access_token, 'get_me')).status()).toBe(401);
    const refreshed = await flow.refresh(tokens.refresh_token);
    expect(refreshed.status()).toBe(200);
    tokens = await refreshed.json();
    await mcp.db("get_user_model().objects.filter(username='demo').update(is_active=False)\nprint('null')");
    expect((await flow.rpc(tokens.access_token, 'get_me')).status()).toBe(401);
    expect((await flow.refresh(tokens.refresh_token)).status()).toBe(400);
    await mcp.db("get_user_model().objects.filter(username='demo').update(is_active=True)\nMembership.objects.filter(user__username='demo').delete()\nprint('null')");
    expect((await flow.call(tokens.access_token, 'list_workspaces')).items).toEqual([]);
    expect((await (await flow.rpc(tokens.access_token, 'list_projects', { workspace_id: bearer.workspace_id })).json()).error.message).toContain('Unknown tool');
  });

  test('MCP OAuth grants cannot share bearer cursors or replay another consent grant', async ({ appPage: page, baseURL }) => {
    const bearer = await mcp.setup(page);
    const cursor = (await bearer.call('list_tasks', { ...bearer.scope, limit: 1 })).next_cursor;
    const first = await oauth.start(page, baseURL);
    const firstCode = await oauth.decide(page, first, { workspaces: [bearer.workspace_id] });
    const firstTokens = await (await first.exchange(firstCode.get('code'))).json();
    const rejected = await first.rpc(firstTokens.access_token, 'list_tasks', { ...bearer.scope, limit: 1, cursor });
    expect(JSON.stringify(await rejected.json())).toContain('Cursor does not match');
    const args = { ...bearer.scope, operation_id: mcp.randomUUID(), name: 'Distinct consent' };
    const created = await first.call(firstTokens.access_token, 'create_project', args);
    const second = await oauth.start(page, baseURL);
    const secondCode = await oauth.decide(page, second, { workspaces: [bearer.workspace_id] });
    const secondTokens = await (await second.exchange(secondCode.get('code'))).json();
    const other = await second.call(secondTokens.access_token, 'create_project', args);
    expect(other.item.id).not.toBe(created.item.id);
  });

  test('MCP OAuth operator revocation and cleanup preserve active grant families', async ({ appPage: page, baseURL }) => {
    const bearer = await mcp.setup(page);
    const flow = await oauth.start(page, baseURL);
    const callback = await oauth.decide(page, flow, { workspaces: [bearer.workspace_id] });
    const tokens = await (await flow.exchange(callback.get('code'))).json();
    const command = (...args) => promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'mcp_access', ...args], { cwd: path.resolve(__dirname, '../..'), env: djangoEnv() });
    await mcp.db("from django_mcpz.oauth.models import AuthorizationCode\nAuthorizationCode.objects.update(expires_at=timezone.now()-timedelta(minutes=1))\nprint('null')");
    await command('cleanup');
    expect((await flow.call(tokens.access_token, 'get_me')).username).toBe('demo');
    const policy = await mcp.db("print(json.dumps(MCPAccessPolicy.objects.get(oauth_code__isnull=False).pk))");
    const listed = await command('oauth-list');
    expect(listed.stdout).toContain('Test assistant');
    expect(listed.stdout).not.toContain(tokens.access_token);
    await command('oauth-revoke', String(policy));
    expect((await flow.rpc(tokens.access_token, 'get_me')).status()).toBe(401);
    expect((await flow.refresh(tokens.refresh_token)).status()).toBe(400);
    await command('cleanup');
    expect(await mcp.db("from django_mcpz.oauth.models import AuthorizationCode\nprint(json.dumps(AuthorizationCode.objects.count()))")).toBe(0);
  });

  test('MCP OAuth migration preserves existing bearer policies and mutation receipts', async ({ appPage: page }) => {
    const bearer = await mcp.setup(page);
    const args = { ...bearer.scope, operation_id: mcp.randomUUID(), name: 'Before OAuth migration' };
    const result = await bearer.call('create_project', args);
    const migrated = await mcp.db(`
from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
try:
    call_command('migrate','data','0033',interactive=False,verbosity=0)
    apps=MigrationExecutor(connection).loader.project_state([('data','0033_mcpaccesspolicy_mcpmutationreceipt')]).apps
    receipt=apps.get_model('data','MCPMutationReceipt').objects.get(operation_id='${args.operation_id}')
    legacy_token=receipt.token_id
finally:
    call_command('migrate','data',interactive=False,verbosity=0)
print(json.dumps({'token':legacy_token,'policy':MCPMutationReceipt.objects.get(operation_id='${args.operation_id}').policy.token_id}))`);
    expect(migrated).toEqual({ token: bearer.token_id, policy: bearer.token_id });
    expect(await bearer.call('create_project', args)).toEqual(result);
  });

  test('MCP OAuth consent is translated and preserves CSRF and anti-framing headers', async ({ appPage: page, baseURL }) => {
    const flow = await oauth.start(page, baseURL);
    await page.context().addCookies([{ name: 'django_language', value: 'de', url: baseURL }]);
    const response = await page.goto(flow.url);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(response.headers()['referrer-policy']).toBe('same-origin');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('heading', { name: 'Assistent verbinden' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zugriff erlauben' })).toBeVisible();
  });

  test('MCP discovers all 82 typed tools and initializes without sessions', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    const initialized = await api.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(initialized.status()).toBe(200);
    expect(initialized.headers()['mcp-session-id']).toBeUndefined();
    const response = await api.rpc('tools/list');
    expect(response.status()).toBe(200);
    const tools = (await response.json()).result.tools;
    expect(tools.map(t => t.name).sort()).toEqual([...mcp.expectedTools].sort());
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.type).toBe('object');
    }
  });

  test('MCP task mutations commit, cascade, replay and reject stale or foreign inputs atomically', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    const projects = await api.call('list_projects', api.scope);
    const project = projects.items[0];
    const people = await api.call('list_people', api.scope);
    const args = { ...api.scope, operation_id: mcp.randomUUID(), project_id: project.id, title: 'MCP task', start: '2030-01-01', end: '2030-01-03', assignee_ids: [people.items[0].id] };
    const created = await api.call('create_task', args);
    expect(created.item.title).toBe('MCP task');
    expect((await api.call('create_task', args))).toEqual(created);
    const changedPayload = await api.raw('create_task', { ...args, title: 'different' });
    expect(JSON.stringify(changedPayload)).toContain('conflict');
    const invalid = await api.raw('update_task', { ...api.scope, operation_id: mcp.randomUUID(), id: created.item.id, if_match: created.item.revision, title: 'must roll back', assignee_ids: [999999] });
    expect(JSON.stringify(invalid)).toContain('not_found');
    expect((await api.call('get_task', { ...api.scope, id: created.item.id })).item.title).toBe('MCP task');
    const moved = await api.mutate('move_task', { id: created.item.id, if_match: created.item.revision, new_start: '2030-02-01' });
    expect(moved.item.end).toBe('2030-02-03');
    const stale = await api.raw('update_task', { ...api.scope, operation_id: mcp.randomUUID(), id: moved.item.id, if_match: created.item.revision, title: 'stale' });
    expect(JSON.stringify(stale)).toContain('conflict');
    const foreign = await api.raw('get_task', { workspace_id: api.foreign_workspace_id, id: moved.item.id });
    expect(JSON.stringify(foreign)).toContain('not_found');
    await page.reload();
    expect(await page.locator(`[data-task-id="${moved.item.id}"]`).count()).toBeGreaterThan(0);
    const removed = await api.mutate('delete_task', { id: moved.item.id, if_match: moved.item.revision });
    expect(removed.deleted_ids).toContain(moved.item.id);
    const activity = await api.call('list_activity', { ...api.scope, entity_type: 'task', entity_id: moved.item.id });
    expect(activity.items.map(e => e.action)).toContain('task.created');
  });

  test('MCP scopes tokens, ignores browser workspace and filters capabilities', async ({ appPage: page }) => {
    const api = await mcp.setup(page, { user: 'pm2', caps: ['core.read'] });
    const session = (await page.context().cookies()).find(c => c.name === 'nano_pm_sessionid').value;
    await mcp.db(`from django.contrib.sessions.backends.db import SessionStore\ns=SessionStore(session_key=${JSON.stringify(session)})\ns['active_workspace_id']=${api.workspace_id}\ns.save()\nprint('null')`);
    const workspaces = await api.call('list_workspaces');
    expect(await mcp.db(`from django.contrib.sessions.backends.db import SessionStore\nprint(json.dumps(SessionStore(session_key=${JSON.stringify(session)}).get('active_workspace_id')))`)).toBe(api.workspace_id);
    expect(workspaces.items.map(w => w.id)).toEqual([api.workspace_id]);
    expect((await api.call('list_projects', api.scope)).items).toEqual([]);
    const response = await api.rpc('tools/list');
    const names = (await response.json()).result.tools.map(t => t.name);
    expect(names).toContain('list_tasks');
    for (const forbidden of ['create_task', 'get_my_workload', 'list_memberships', 'get_public_roadmap_link']) {
      expect(names).not.toContain(forbidden);
      expect((await api.raw(forbidden, api.scope)).error.message).toContain('Unknown tool');
    }
    expect(JSON.stringify(await api.raw('list_projects', { workspace_id: api.foreign_workspace_id }))).toContain('not_found');
    expect((await api.rpc('tools/list', {}, { Origin: 'https://attacker.invalid' })).status()).toBe(403);
    await mcp.db(`Token.objects.filter(pk=${api.token_id}).update(revoked_at=timezone.now())\nprint('null')`);
    expect((await api.rpc('tools/list')).status()).toBe(401);
  });

  test('MCP rejects missing policy, expired tokens, inactive users and removed memberships', async ({ appPage: page }) => {
    for (const change of ['MCPAccessPolicy.objects.filter(token_id=TOKEN).delete()', 'Token.objects.filter(pk=TOKEN).update(expires_at=timezone.now()-timedelta(seconds=1))', 'Token.objects.filter(pk=TOKEN).update(expires_at=None)', "get_user_model().objects.filter(username='demo').update(is_active=False)"]) {
      const api = await mcp.setup(page);
      await mcp.db(`${change.replace('TOKEN', api.token_id)}\nprint('null')`);
      expect([401, 403]).toContain((await api.rpc('tools/list')).status());
      await mcp.db("get_user_model().objects.filter(username='demo').update(is_active=True)\nprint('null')");
    }
    const api = await mcp.setup(page);
    await mcp.db(`Membership.objects.filter(user__username='demo', workspace_id=${api.workspace_id}).delete()\nprint('null')`);
    expect((await api.call('list_workspaces')).items).toEqual([]);
    expect((await api.raw('list_tasks', api.scope)).error.message).toContain('Unknown tool');
  });

  test('MCP validates typed arguments, binds cursors and limits requests', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    const first = await api.call('list_tasks', { ...api.scope, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = await api.call('list_tasks', { ...api.scope, limit: 2, cursor: first.next_cursor });
    expect(second.items.map(t => t.id).some(id => first.items.map(t => t.id).includes(id))).toBe(false);
    for (const args of [{ limit: 101 }, { workspace_id: 'wrong' }, { unexpected: true }, { cursor: first.next_cursor, search: 'other', limit: 2 }]) {
      expect((await api.raw('list_tasks', { ...api.scope, ...args })).result.isError).toBe(true);
    }
    const response = await page.request.post('/mcp', { headers: { Authorization: `Bearer ${api.token}` }, data: 'x'.repeat(131073) });
    expect(response.status()).toBe(413);
    await mcp.db(`MCPAccessPolicy.objects.filter(token_id=${api.token_id}).update(rate_count=240, rate_window=timezone.now())\nprint('null')`);
    expect((await api.rpc('tools/list')).status()).toBe(429);
  });

  test('MCP project workspace and people mutations preserve permissions and relationships', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    const me = await api.call('get_me');
    expect(me.username).toBe('demo');
    const current = (await api.call('get_workspace', api.scope)).item;
    const renamed = await api.mutate('update_workspace', { if_match: current.revision, name: 'MCP workspace', prompt_milestone_move_reason: false });
    expect(renamed.item.name).toBe('MCP workspace');
    const team = (await api.mutate('create_team', { name: 'MCP team' })).item;
    const person = (await api.mutate('create_person', { name: 'MCP person', team_ids: [team.id] })).item;
    expect((await api.call('get_person', { ...api.scope, id: person.id })).item.team_ids).toEqual([team.id]);
    const changedPerson = (await api.mutate('update_person', { id: person.id, if_match: person.revision, name: 'Changed person', team_ids: [] })).item;
    let teams = await api.call('list_teams', api.scope);
    const changedTeam = (await api.mutate('update_team', { id: team.id, if_match: teams.items.find(t => t.id === team.id).revision, name: 'Changed team' })).item;
    const project = (await api.mutate('create_project', { name: 'MCP project', description: 'Description', responsible_person_ids: [person.id] })).item;
    expect(project.public_roadmap_visible).toBe(false);
    let updated = (await api.mutate('update_project', { id: project.id, if_match: project.revision, name: 'Changed project', color: '#123456', public_roadmap_visible: true })).item;
    expect(updated.public_roadmap_visible).toBe(true);
    updated = (await api.mutate('set_project_completed', { id: project.id, if_match: updated.revision, completed: true })).item;
    expect(updated.completed_at).toBeTruthy();
    updated = (await api.mutate('set_project_completed', { id: project.id, if_match: updated.revision, completed: false })).item;
    const ordered = await api.call('list_projects', api.scope);
    await api.mutate('reorder_projects', { if_match: ordered.revision, project_ids: [...ordered.items.map(p => p.id)].reverse() });
    updated = (await api.call('get_project', { ...api.scope, id: project.id })).item;
    const destination = (await api.call('create_workspace', { name: 'Destination', operation_id: mcp.randomUUID() })).item;
    const transferArgs = { ...api.scope, operation_id: mcp.randomUUID(), id: project.id, if_match: updated.revision, target_workspace_id: destination.id };
    const transferred = await api.call('move_project_to_workspace', transferArgs);
    expect(transferred.item.workspace_id).toBe(destination.id);
    await mcp.db(`MCPAccessPolicy.objects.get(token_id=${api.token_id}).workspaces.remove(${destination.id})\nprint('null')`);
    expect(JSON.stringify(await api.raw('move_project_to_workspace', transferArgs))).toContain('not_found');
    await mcp.db(`MCPAccessPolicy.objects.get(token_id=${api.token_id}).workspaces.add(${destination.id})\nprint('null')`);
    await api.mutate('delete_project', { workspace_id: destination.id, id: project.id, if_match: transferred.item.revision });
    await api.mutate('delete_person', { id: person.id, if_match: (await api.call('get_person', { ...api.scope, id: person.id })).item.revision });
    teams = await api.call('list_teams', api.scope);
    await api.mutate('delete_team', { id: team.id, if_match: teams.items.find(t => t.id === changedTeam.id).revision });
    expect(changedPerson.name).toBe('Changed person');
  });

  test('MCP dependencies cascade, milestones enforce reasons and bulk moves are atomic', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    const project = (await api.mutate('create_project', { name: 'Schedule' })).item;
    let a = (await api.mutate('create_task', { project_id: project.id, title: 'A', start: '2030-01-01', end: '2030-01-03' })).item;
    let b = (await api.mutate('create_task', { project_id: project.id, title: 'B', start: '2030-01-01', end: '2030-01-02' })).item;
    const edge = (await api.mutate('add_dependency', { predecessor_id: a.id, successor_id: b.id, predecessor_revision: a.revision, successor_revision: b.revision })).item;
    b = (await api.call('get_task', { ...api.scope, id: b.id })).item;
    expect(b.start >= a.end).toBe(true);
    a = (await api.call('get_task', { ...api.scope, id: a.id })).item;
    const cycle = await api.raw('add_dependency', { ...api.scope, operation_id: mcp.randomUUID(), predecessor_id: b.id, successor_id: a.id, predecessor_revision: b.revision, successor_revision: a.revision });
    expect(JSON.stringify(cycle)).toContain('cycle_detected');
    const german = await api.rpc('tools/call', { name: 'add_dependency', arguments: { ...api.scope, operation_id: mcp.randomUUID(), predecessor_id: b.id, successor_id: a.id, predecessor_revision: b.revision, successor_revision: a.revision } }, { 'Accept-Language': 'de' });
    expect(JSON.stringify(await german.json())).toContain('cycle_detected');
    expect((await api.call('list_dependencies', { ...api.scope, project_id: project.id })).items).toHaveLength(1);
    let milestone = (await api.mutate('create_milestone', { project_id: project.id, task_id: b.id, title: 'Linked', date: b.end, require_move_reason: true })).item;
    expect((await api.call('get_milestone', { ...api.scope, id: milestone.id })).item.task_id).toBe(b.id);
    const noReason = await api.raw('update_milestone', { ...api.scope, operation_id: mcp.randomUUID(), id: milestone.id, if_match: milestone.revision, date: '2030-01-20' });
    expect(JSON.stringify(noReason)).toContain('reason_required');
    milestone = (await api.mutate('update_milestone', { id: milestone.id, if_match: milestone.revision, date: '2030-01-20', move_reason: 'Scope changed' })).item;
    expect((await api.call('get_task', { ...api.scope, id: b.id })).item.end).toBe('2030-01-20');
    expect((await api.call('list_milestones', { ...api.scope, project_id: project.id })).items).toHaveLength(1);
    const schedule = await api.call('get_schedule', { ...api.scope, start: '2030-01-01', end: '2030-03-01', project_ids: [project.id] });
    expect(schedule.items).toHaveLength(3);
    const before = (await api.call('get_task', { ...api.scope, id: a.id })).item;
    const invalid = await api.raw('move_tasks', { ...api.scope, operation_id: mcp.randomUUID(), targets: [{ id: a.id, if_match: before.revision }, { id: 999999, if_match: before.revision }], delta_days: 2 });
    expect(JSON.stringify(invalid)).toContain('not_found');
    expect((await api.call('get_task', { ...api.scope, id: a.id })).item.start).toBe(before.start);
    const moved = await api.mutate('move_tasks', { targets: [{ id: a.id, if_match: before.revision }], delta_days: 2 });
    expect(moved.effects.tasks.changed_count).toBeGreaterThan(0);
    await api.mutate('delete_dependency', { predecessor_id: a.id, successor_id: b.id, if_match: edge.revision });
    milestone = (await api.call('get_milestone', { ...api.scope, id: milestone.id })).item;
    await api.mutate('delete_milestone', { id: milestone.id, if_match: milestone.revision });
    expect((await api.call('get_task', { ...api.scope, id: b.id })).item.id).toBe(b.id);
  });

  test('MCP idea conversions are atomic and cannot create duplicate projects or tasks', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    let idea = (await api.mutate('create_idea', { title: 'Idea', body: 'Copy this body', tags: 'mcp' })).item;
    idea = (await api.mutate('update_idea', { id: idea.id, if_match: idea.revision, status: 'exploring' })).item;
    expect((await api.call('list_ideas', { ...api.scope, tag: 'mcp' })).items).toHaveLength(1);
    const args = { ...api.scope, operation_id: mcp.randomUUID(), id: idea.id, if_match: idea.revision };
    const converted = await api.call('convert_idea_to_project', args);
    expect(converted.project.description).toBe('Copy this body');
    expect(await api.call('convert_idea_to_project', args)).toEqual(converted);
    const twice = await api.raw('convert_idea_to_project', { ...args, operation_id: mcp.randomUUID(), if_match: converted.item.revision });
    expect(JSON.stringify(twice)).toContain('conflict');
    const other = (await api.mutate('create_idea', { title: 'Task idea', body: 'Task body' })).item;
    const task = await api.mutate('convert_idea_to_task', { id: other.id, if_match: other.revision, project_id: converted.project.id, start: '2030-01-01', end: '2030-01-02' });
    expect(task.task.description).toBe('Task body');
    expect((await api.call('get_idea', { ...api.scope, id: other.id })).item.converted_task_id).toBe(task.task.id);
    await api.mutate('delete_idea', { id: other.id, if_match: task.item.revision });
    expect((await api.call('get_task', { ...api.scope, id: task.task.id })).item.id).toBe(task.task.id);
  });

  test('MCP member writes honor assignment and explicit self-claim permissions', async ({ appPage: page }) => {
    const pm = await mcp.setup(page);
    const project = (await pm.mutate('create_project', { name: 'Claimable' })).item;
    let task = (await pm.mutate('create_task', { project_id: project.id, title: 'Claim task', start: '2030-01-01', end: '2030-01-02' })).item;
    const member = await mcp.setup(page, { user: 'member1', caps: ['core.read', 'core.write', 'workspace.admin'] });
    const claim = await member.mutate('claim_task', { id: task.id, if_match: task.revision });
    expect(claim.item.assignee_ids).toHaveLength(1);
    const claimedProject = await member.mutate('claim_project', { id: project.id, if_match: (await member.call('get_project', { ...member.scope, id: project.id })).item.revision });
    expect(claimedProject.item.responsible_person_ids).toHaveLength(1);
    task = (await member.mutate('update_task', { id: task.id, if_match: claim.item.revision, title: 'Assigned edit' })).item;
    expect(task.title).toBe('Assigned edit');
    const all = await member.call('list_tasks', member.scope);
    const forbiddenTask = all.items.find(t => t.assignee_ids.length && !t.assignee_ids.includes(claim.item.assignee_ids[0]));
    const denied = await member.raw('delete_task', { ...member.scope, operation_id: mcp.randomUUID(), id: forbiddenTask.id, if_match: forbiddenTask.revision });
    expect(JSON.stringify(denied)).toContain('forbidden');
    expect((await member.raw('list_memberships', member.scope)).error.message).toContain('Unknown tool');
  });

  test('MCP concurrent updates and retries produce one committed result', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    const item = (await api.mutate('create_project', { name: 'Concurrency' })).item;
    const args = { ...api.scope, operation_id: mcp.randomUUID(), id: item.id, if_match: item.revision, name: 'Exactly once' };
    const [a, b] = await Promise.all([api.call('update_project', args), api.call('update_project', args)]);
    expect(a).toEqual(b);
    const competing = await Promise.all(['A', 'B'].map(name => api.raw('update_project', { ...args, operation_id: mcp.randomUUID(), if_match: a.item.revision, name })));
    expect(competing.filter(x => x.result?.isError)).toHaveLength(1);
    expect(JSON.stringify(competing)).toContain('conflict');
  });

  test('MCP workload tools preserve immutable estimates and private self-service boundaries', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    const settings = (await api.call('get_workload_settings', api.scope)).item;
    const enabled = await api.mutate('update_workload_settings', { if_match: settings.revision, workload_enabled: true, workload_pms_included: true });
    expect(enabled.item.workload_members_included).toBe(true);
    let category = (await api.mutate('create_workload_category', { name: 'MCP allocation', active: false, supports_projects: true })).item;
    category = (await api.mutate('update_workload_category', { id: category.id, if_match: category.revision, active: true })).item;
    const categories = (await api.call('list_workload_categories', api.scope)).items;
    const my = (await api.call('get_my_workload', api.scope)).item;
    const allocations = categories.filter(c => c.active).map(c => ({ category_id: c.id, percentage: c.id === category.id ? 100 : 0, projects: c.id === category.id ? [{ project_id: my.projects[0].id, percentage: 75 }] : [] }));
    const submitted = await api.mutate('submit_my_workload', { if_match: my.revision, allocations, checkin: true });
    expect(submitted.item.allocations.find(a => a.category_id === category.id).percentage).toBe(100);
    const reviewed = await api.mutate('review_my_workload', { if_match: submitted.state.revision });
    expect(reviewed.item.id).not.toBe(submitted.item.id);
    const snoozed = await api.mutate('snooze_my_workload_checkin', { if_match: reviewed.state.revision });
    expect(snoozed.item.snoozed_until).toBeTruthy();
    expect((await api.call('list_workload_reports', api.scope)).items).toHaveLength(2);
    expect((await api.call('get_workload_report', { ...api.scope, id: submitted.item.id })).item.id).toBe(submitted.item.id);
    expect((await api.call('get_workload_overview', api.scope)).reported).toBe(1);
    const membership = (await api.call('list_memberships', api.scope)).items.find(m => m.user_label === 'member1');
    const participation = await api.mutate('set_workload_participation', { id: membership.id, if_match: membership.revision, value: 'exempt' });
    expect(participation.item.workload_participation).toBe('exempt');
    const member = await mcp.setup(page, { user: 'member1', caps: ['workload.self'] });
    expect(JSON.stringify(await member.raw('get_my_workload', member.scope))).toContain('feature_disabled');
    expect(JSON.stringify(await member.raw('get_workload_report', { ...member.scope, id: submitted.item.id }))).toContain('not_found');
    const readOnly = await mcp.setup(page, { caps: ['core.read'] });
    expect((await readOnly.raw('list_workload_reports', readOnly.scope)).error.message).toContain('Unknown tool');
    await api.mutate('delete_workload_category', { id: category.id, if_match: category.revision });
    const historical = (await api.call('get_workload_report', { ...api.scope, id: submitted.item.id })).item;
    expect(historical.allocations.find(a => a.category_label === 'MCP allocation')).toMatchObject({ category_id: null, percentage: 100 });
  });

  test('MCP sharing links and role mutations are explicit, redacted and replay-safe', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    const members = (await api.call('list_memberships', api.scope)).items;
    const own = members.find(m => m.user_label === 'demo');
    const last = await api.raw('set_member_role', { ...api.scope, operation_id: mcp.randomUUID(), id: own.id, if_match: own.revision, role: 'member' });
    expect(JSON.stringify(last)).toContain('last PM');
    const member = members.find(m => m.user_label === 'member1');
    const promoted = await api.mutate('set_member_role', { id: member.id, if_match: member.revision, role: 'pm' });
    expect(promoted.item.role).toBe('pm');
    const person = (await api.call('list_people', api.scope)).items.find(p => !p.linked);
    const invite = await api.mutate('create_person_invite', { id: person.id, if_match: person.revision });
    expect(invite.url).toContain('/invite/');
    const initial = (await api.call('get_public_roadmap_settings', api.scope)).item;
    let roadmap = await api.mutate('update_public_roadmap_settings', { if_match: initial.revision, enabled: true, title: 'MCP roadmap' });
    const original = await api.call('get_public_roadmap_link', api.scope);
    const args = { ...api.scope, operation_id: mcp.randomUUID(), if_match: roadmap.item.revision };
    const rotated = await api.call('rotate_public_roadmap_link', args);
    expect(rotated.url).not.toBe(original.url);
    expect(await api.call('rotate_public_roadmap_link', args)).toEqual(rotated);
    expect((await page.request.get(original.url)).status()).toBe(404);
    roadmap = await api.call('get_public_roadmap_settings', api.scope);
    await api.mutate('rotate_public_roadmap_link', { if_match: roadmap.item.revision });
    expect(JSON.stringify(await api.raw('rotate_public_roadmap_link', args))).toContain('conflict');
    const project = (await api.call('list_projects', api.scope)).items[0];
    await api.mutate('set_my_project_subscription', { id: project.id, if_match: project.revision, subscribed: true });
    expect((await api.call('list_my_project_subscriptions', api.scope)).items).toHaveLength(1);
    await api.mutate('set_my_project_subscription', { id: project.id, if_match: project.revision, subscribed: false });
    expect((await api.call('list_my_project_subscriptions', api.scope)).items).toHaveLength(0);
    const notification = (await api.call('get_notification_settings', api.scope)).item;
    const changed = await api.mutate('update_notification_settings', { if_match: notification.revision, events: ['milestone.moved'], subscriber_domains: ['example.com'] });
    expect(changed.item.events).toEqual(['milestone.moved']);
    expect((await api.call('list_notification_deliveries', api.scope)).items).toEqual([]);
    const secretChecks = await mcp.db(`w=Workspace.objects.get(pk=${api.workspace_id})\nprint(json.dumps({'receipts':list(MCPMutationReceipt.objects.values_list('result', flat=True)), 'token':w.public_roadmap_token}))`);
    expect(JSON.stringify(secretChecks.receipts)).not.toContain(secretChecks.token);
    const core = await mcp.setup(page, { caps: ['core.read', 'core.write'] });
    for (const tool of ['get_public_roadmap_link', 'create_person_invite']) expect((await core.raw(tool, core.scope)).error.message).toContain('Unknown tool');
    const activity = await core.call('list_activity', core.scope);
    expect(JSON.stringify(activity)).not.toContain(secretChecks.token);
  });

  test('MCP GitLab tools use cached data, stable revisions and queued sync without exposing credentials', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    const ids = await mcp.db(`
w=Workspace.objects.get(pk=${api.workspace_id})
c=GitLabConnection.objects.create(workspace=w,instance_url='https://gitlab.example.com',token_ciphertext='never-return-this',enabled=True)
projects=list(Project.objects.filter(workspace=w).order_by('id'))
i=GitLabIssue.objects.create(connection=c,gitlab_project_id=1,iid=1,title='MCP cached issue',owner=projects[0],web_url='https://gitlab.example.com/p/-/issues/1')
print(json.dumps({'issue':i.pk,'source':projects[0].pk,'target':projects[1].pk}))`);
    const listed = (await api.call('list_gitlab_issues', api.scope)).items[0];
    let issue = (await api.call('get_gitlab_issue', { ...api.scope, id: ids.issue })).item;
    expect(listed.revision).toBe(issue.revision);
    const binding = (await api.call('get_project_gitlab_binding', { ...api.scope, id: ids.source })).item;
    await api.mutate('update_project_gitlab_binding', { id: ids.source, if_match: binding.revision, prefix: 'MCP', collect: true });
    issue = (await api.mutate('transfer_gitlab_issue', { id: ids.issue, if_match: issue.revision, project_id: ids.target })).item;
    expect(issue.owner_id).toBe(ids.target);
    let connection = (await api.call('get_gitlab_connection', api.scope)).item;
    expect(JSON.stringify(connection)).not.toContain('never-return-this');
    connection = (await api.mutate('request_gitlab_sync', { if_match: connection.revision })).item;
    const workflow = await api.mutate('update_gitlab_workflow', { if_match: connection.revision, in_progress_labels: ['Doing'], done_labels: ['Done'], not_started_labels: ['Ready'], fallback: 'unclassified' });
    expect(workflow.item.workflow['in-progress']).toEqual(['Doing']);
  });

  test('MCP and OAuth are available without opt-in and operator credentials remain restricted', async ({ appPage: page }) => {
    expect((await page.request.post('/mcp', { data: {} })).status()).toBe(401);
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server/oauth', '/accounts/mcp/']) {
      expect((await page.request.get(path)).status()).toBe(200);
    }
    for (const path of ['/oauth/token', '/oauth/register', '/oauth/revoke']) {
      expect((await page.request.get(path)).status()).toBe(405);
    }
    await page.goto('/profile/');
    await expect(page.getByRole('link', { name: 'Assistant connections', exact: true })).toBeVisible();
    const ws = await mcp.db("print(json.dumps(Membership.objects.get(user__username='demo').workspace_id))");
    const command = (...args) => promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'mcp_access', ...args], { cwd: path.resolve(__dirname, '../..'), env: djangoEnv() });
    const { stdout } = await command('create', 'Playwright operator', '--user', 'demo', '--workspace', String(ws), '--capability', 'core.read', '--expires-in-days', '1');
    const credential = stdout.trim();
    expect(credential).toMatch(/^mcp_/);
    const result = await page.request.post('/mcp', { headers: { Authorization: `Bearer ${credential}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(result.status()).toBe(200);
    expect((await result.json()).result.tools.map(t => t.name)).not.toContain('create_task');
    const tokenId = await mcp.db("print(json.dumps(Token.objects.get(name='Playwright operator').pk))");
    await command('configure', String(tokenId), '--workspace', String(ws), '--capability', 'core.read', '--capability', 'core.write');
    await command('revoke', String(tokenId));
    await command('cleanup');
    expect(await mcp.db(`print(json.dumps(Token.objects.filter(pk=${tokenId}).exists()))`)).toBe(false);
  });

  test('MCP oversized mutation results roll back state, activity and retry receipts together', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    const ids = await mcp.db(`
p=Project.objects.filter(workspace_id=${api.workspace_id}).first()
from datetime import date
objects=Task.objects.bulk_create([Task(project=p,title=f'Oversized {i}',description='x'*20000,start=date(2030,1,1),end=date(2030,1,2)) for i in range(20)])
print(json.dumps([o.pk for o in objects]))`);
    const targets = [];
    for (const id of ids) targets.push({ id, if_match: (await api.call('get_task', { ...api.scope, id })).item.revision });
    const operation = mcp.randomUUID();
    const response = await api.raw('move_tasks', { ...api.scope, operation_id: operation, targets, delta_days: 2 });
    expect(JSON.stringify(response)).toContain('Result too large');
    const state = await mcp.db(`print(json.dumps({'starts':list(Task.objects.filter(pk__in=${JSON.stringify(ids)}).values_list('start',flat=True)), 'events':ActivityEvent.objects.filter(action='tasks.bulk_moved').count(), 'receipts':MCPMutationReceipt.objects.filter(operation_id='${operation}').count()},default=str))`);
    expect(new Set(state.starts)).toEqual(new Set(['2030-01-01']));
    expect(state.events).toBe(0);
    expect(state.receipts).toBe(0);
  });

  test('MCP retry replay rechecks current object permissions and token workspace bindings', async ({ appPage: page }) => {
    const pm = await mcp.setup(page);
    const project = (await pm.mutate('create_project', { name: 'Replay access' })).item;
    let task = (await pm.mutate('create_task', { project_id: project.id, title: 'Unassigned', start: '2030-01-01', end: '2030-01-02' })).item;
    const member = await mcp.setup(page, { user: 'member1', caps: ['core.read', 'core.write'] });
    const args = { ...member.scope, operation_id: mcp.randomUUID(), id: task.id, if_match: task.revision, title: 'Previously allowed' };
    task = (await member.call('update_task', args)).item;
    const others = (await pm.call('list_people', pm.scope)).items;
    const unlinked = others.find(p => !p.linked);
    await pm.mutate('update_task', { id: task.id, if_match: task.revision, assignee_ids: [unlinked.id] });
    expect(JSON.stringify(await member.raw('update_task', args))).toContain('forbidden');
    await mcp.db(`MCPAccessPolicy.objects.get(token_id=${member.token_id}).workspaces.clear()\nprint('null')`);
    expect((await member.raw('update_task', args)).error.message).toContain('Unknown tool');
  });

  test('MCP reads redact historical secrets and delivery payloads', async ({ appPage: page }) => {
    const api = await mcp.setup(page);
    await mcp.db(`
w=Workspace.objects.get(pk=${api.workspace_id})
w.teams_webhook_url='https://example.com/secret-webhook';w.save()
ActivityEvent.objects.create(workspace=w,action='workspace.updated',entity_type='workspace',entity_id=w.pk,entity_label='secret-label',changes={'teams_webhook_url':{'to':'secret-webhook'},'public_roadmap_token':{'to':'secret-roadmap'}},metadata={'email':'secret-email'})
TeamsDelivery.objects.create(workspace=w,destination_hash='x'*64,payload={'email':'secret-email'},last_error='secret-error')
print('null')`);
    const settings = await api.call('get_notification_settings', api.scope);
    expect(settings.item.configured).toBe(true);
    const deliveries = await api.call('list_notification_deliveries', api.scope);
    const history = await api.call('list_activity', api.scope);
    for (const value of [settings, deliveries, history]) expect(JSON.stringify(value)).not.toContain('secret-');
  });

  test('MCP requires bearer authentication even with a browser session', async ({ appPage: page }) => {
    const response = await page.request.post('/mcp', {
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(response.status()).toBe(401);
    expect(response.headers()['www-authenticate']).toContain('Bearer');
  });
});

test.describe('GitLab integration', () => {
  test('GitLab configuration lives inside workspace settings rather than the main navigation', async ({ appPage: page }, testInfo) => {
    const api = await fakeGitLab();
    try {
      await expect(page.locator('.drawer-side').getByRole('link', { name: 'GitLab integration', exact: true })).toHaveCount(0);
      await page.locator('.ws-settings-link').click();
      await expect(page.getByRole('heading', { name: 'Workspace settings', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'GitLab integration', exact: true })).toHaveCount(0);
      const workspaceName = await page.locator('#workspace-settings-name').inputValue();
      await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Integrations', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'GitLab integration', exact: true })).toBeVisible();
      await connectGitLab(page, api);
      await expect(page).toHaveURL('/workspaces/settings/integrations/');
      await page.getByLabel('Done labels').fill('Ready to deploy');
      await page.getByRole('button', { name: 'Save GitLab workflow', exact: true }).click();
      await expect(page).toHaveURL('/workspaces/settings/integrations/');
      await expect(page.getByLabel('Done labels')).toHaveValue('Ready to deploy');
      await page.locator('#workspace-gitlab-settings').screenshot({ path: testInfo.outputPath('workspace-gitlab-settings.png') });
      await page.getByLabel('GitLab instance URL').fill('http://example.com');
      await page.getByRole('button', { name: 'Save GitLab connection', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Workspace settings', exact: true })).toBeVisible();
      await expect(page.locator('#workspace-gitlab-settings')).toContainText('Enter an HTTPS GitLab origin');
      await expect(page.getByLabel('GitLab instance URL')).toHaveValue('http://example.com');
      const workloadError = await page.request.post('/workspaces/workload/', {
        form: { action: 'category', name: '', csrfmiddlewaretoken: await page.locator('[name=csrfmiddlewaretoken]').first().inputValue() },
        headers: { Referer: page.url() },
      });
      expect(workloadError.status()).toBe(200);
      expect(await workloadError.text()).toContain('class="tab tab-active" aria-current="page">Workload');
      expect(await workloadError.text()).not.toContain('id="workspace-gitlab-settings"');
      await page.goto('/workspaces/gitlab/');
      await expect(page).toHaveURL('/workspaces/settings/integrations/');
      await expect(page.locator('#gitlab-connection-status')).toContainText('Connected');
      await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'General', exact: true }).click();
      await expect(page.locator('#workspace-settings-name')).toHaveValue(workspaceName);
      await expect(page.getByLabel('Offer a reason when moving milestones')).toBeChecked();
    } finally { await api.close(); }
  });

  test('GitLab deployment reads DJANGO-prefixed environment variables', async ({ appPage: page }) => {
    await page.goto('/workspaces/settings/integrations/');
    await expect(page.getByRole('heading', { name: 'GitLab integration', exact: true })).toBeVisible();
    const key = Buffer.alloc(32, 42).toString('base64');
    const { stdout } = await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'shell', '-c', `
import json, os
from django.conf import settings
print(json.dumps({
    'key_from_environment': settings.GITLAB_ENCRYPTION_KEY == os.environ['DJANGO_GITLAB_ENCRYPTION_KEY'],
    'private_hosts_from_environment': settings.GITLAB_PRIVATE_HOSTS == ['gitlab.internal.example', 'gitlab.other.example'],
}))
`], {
      cwd: path.resolve(__dirname, '../..'),
      env: djangoEnv({
        DJANGO_SETTINGS_MODULE: 'config.settings',
        DJANGO_GITLAB_ENCRYPTION_KEY: key,
        DJANGO_GITLAB_PRIVATE_HOSTS: 'gitlab.internal.example, gitlab.other.example',
      }),
    });
    expect(JSON.parse(stdout.trim().split('\n').at(-1))).toEqual({
      key_from_environment: true, private_hosts_from_environment: true,
    });
  });

  test('GitLab connection protects credentials and queues synchronization', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      await connectGitLab(page, api);
      await expect(page.getByLabel('GitLab API token')).toHaveValue('');
      expect(await page.content()).not.toContain('test-private-token');
      expect(await gitlabDB(`
from interfaces.gitlab.client import decrypt_token
connection = GitLabConnection.objects.get()
print(json.dumps(connection.token_ciphertext != 'test-private-token' and decrypt_token(connection.token_ciphertext) == 'test-private-token'))
`)).toBe(true);
      await page.getByRole('button', { name: 'Sync GitLab now', exact: true }).click();
      await expect(page.locator('#gitlab-sync-status')).toContainText('Queued');
      await syncGitLab();
      await page.reload();
      await expect(page.locator('#gitlab-sync-status')).toContainText('Up to date');
      expect(api.requests.every(r => r.token === 'test-private-token')).toBe(true);
      await page.getByRole('button', { name: 'Disconnect GitLab', exact: true }).click();
      await expect(page.locator('#gitlab-connection-status')).toContainText('Disconnected');
    } finally { await api.close(); }
  });

  test('GitLab prefixes collect once and preserve ownership when a completed prefix is reused', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const [oldId, newId] = await page.locator('.project-group').evaluateAll(groups => groups.map(g => Number(g.dataset.projectId)));
      api.issues = [api.issue(1, ' Portal : Login'), api.issue(2, 'Portal Admin: Not a match'),
        api.issue(3, 'Portal: Closed work', { state: 'closed' }),
        api.issue(1, 'Portal: Other repository', { project_id: 102 })];
      await connectGitLab(page, api);
      await bindGitLab(page, oldId, 'portal');
      await syncGitLab();
      await page.reload();
      await expect(gitlabRows(page)).toHaveCount(3);
      await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveCount(3);
      api.issues[0].title = 'Different title';
      await postForm(page, `/projects/${oldId}/set-completed/`, {});
      await bindGitLab(page, newId, 'portal');
      // Old creation date deliberately: no dated handover.
      api.issues.push(api.issue(4, 'Portal: Previously undiscovered'));
      await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveCount(1);
      await expect(gitlabRows(page)).toContainText('Previously undiscovered');
      await page.goto(`/projects/${oldId}/`);
      await expect(gitlabRows(page)).toHaveCount(3);
      await expect(page.locator('#gitlab-issues')).toContainText('Different title');
      await expect(page.locator('#gitlab-issues')).toContainText('Prefix changed');
      expect(await postForm(page, `/projects/${oldId}/set-completed/`, {})).toBe(409);
      await page.reload();
      await expect(page.locator('#project-detail-page')).toContainText('Completed');
      await postForm(page, '/projects/toggle-completed/', {});
      await page.goto('/'); await page.locator(`#proj-${oldId} .swatch`).click();
      await expect(page.locator('#project-popover [role=alert]')).toContainText('Disable collection');
      await expect(page.locator('#pp-toggle-complete')).toBeDisabled();
    } finally { await api.close(); }
  });

  test('GitLab label mappings are workspace-wide while projects only configure prefix collection', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const ids = await page.locator('.project-group').evaluateAll(groups => groups.map(g => Number(g.dataset.projectId)));
      api.issues = [
        api.issue(1, 'Portal: Shared workflow', { labels: ['Developing'] }),
        api.issue(2, 'Reports: Shared workflow', { labels: ['Ready'] }),
      ];
      await connectGitLab(page, api);
      await page.getByLabel('In-progress labels').fill('Developing');
      await page.getByLabel('Done labels').fill('Ready');
      await page.getByRole('button', { name: 'Save GitLab workflow', exact: true }).click();
      const workspaceId = await gitlabDB('print(json.dumps(GitLabConnection.objects.get().workspace_id))');
      await bindGitLab(page, ids[0], 'Portal');
      await expect(page.getByLabel('In-progress labels')).toHaveCount(0);
      await expect(page.getByLabel('Done labels')).toHaveCount(0);
      await expect(page.getByLabel('Not-started labels')).toHaveCount(0);
      await expect(page.getByLabel('Override workspace workflow')).toHaveCount(0);
      await expect(page.getByLabel('Unmatched issue state')).toHaveCount(0);
      await page.getByText('GitLab project settings', { exact: true }).click();
      await page.getByRole('link', { name: 'GitLab workflow', exact: true }).click();
      await expect(page).toHaveURL('/workspaces/settings/integrations/');
      await expect(page.getByLabel('Done labels')).toHaveValue('Ready');
      await bindGitLab(page, ids[1], 'Reports');
      // Old clients must not be able to persist a project-specific mapping.
      expect(await postForm(page, `/projects/${ids[0]}/gitlab/`, {
        prefix: 'Portal', collect: 'on', override_workflow: 'on',
        in_progress_labels: '', done_labels: 'Developing', fallback: 'done',
      })).toBe(200);
      await syncGitLab();
      await page.goto(`/projects/${ids[0]}/`);
      await expect(gitlabRows(page)).toHaveAttribute('data-state', 'in-progress');
      await page.goto(`/projects/${ids[1]}/`);
      await expect(gitlabRows(page)).toHaveAttribute('data-state', 'done');
      await page.goto('/workspaces/settings/integrations/');
      await expect(page.getByLabel('Done labels')).toHaveValue('Ready');
      await page.getByLabel('Done labels').fill('Developing');
      await page.getByRole('button', { name: 'Save GitLab workflow', exact: true }).click();
      await syncGitLab();
      await page.goto(`/projects/${ids[0]}/`);
      await expect(gitlabRows(page)).toHaveAttribute('data-state', 'done');
      await page.goto(`/projects/${ids[1]}/`);
      await expect(gitlabRows(page)).toHaveAttribute('data-state', 'unclassified');
      expect(await postForm(page, '/workspaces/', { name: 'Independent workflow workspace' })).toBe(200);
      await connectGitLab(page, api);
      await expect(page.getByLabel('In-progress labels')).toHaveValue('In Development');
      await expect(page.getByLabel('Done labels')).toHaveValue('Next Deployment');
      expect(await postForm(page, `/workspaces/${workspaceId}/switch/`, {})).toBe(200);
      await page.goto('/workspaces/settings/integrations/');
      await expect(page.getByLabel('Done labels')).toHaveValue('Developing');
    } finally { await api.close(); }
  });

  test('GitLab workspace-only workflow migration preserves mappings and queues legacy overrides for refresh', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const id = await page.locator('.project-group').first().getAttribute('data-project-id');
      api.issues = [api.issue(1, 'Portal: Existing ownership', { labels: ['In Development'] })];
      await connectGitLab(page, api); await bindGitLab(page, id, 'Portal'); await syncGitLab();
      const result = await gitlabDB(`
from datetime import timedelta
from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone
call_command('migrate', 'data', '0031', interactive=False, verbosity=0)
legacy = MigrationExecutor(connection).loader.project_state([('data', '0031_gitlabconnection_gitlabissue_gitlabissueevent_and_more')]).apps
legacy.get_model('data', 'GitLabProjectBinding').objects.filter(project_id=${id}).update(workflow={
    'in-progress': [], 'done': ['In Development'], 'not-started': [], 'fallback': 'unclassified',
})
source = GitLabConnection.objects.get()
previous_revision = source.revision
previous_mapping = source.workflow
GitLabConnection.objects.filter(pk=source.pk).update(needs_backfill=False, next_run=timezone.now() + timedelta(hours=1))
GitLabIssue.objects.update(state='done')
call_command('migrate', 'data', '0032', interactive=False, verbosity=0)
source.refresh_from_db()
# Restore the current schema before this worker serves another fixture reset.
call_command('migrate', 'data', interactive=False, verbosity=0)
print(json.dumps({
    'queued': source.needs_backfill and source.next_run is None and source.revision > previous_revision,
    'workspace_mapping_preserved': source.workflow == previous_mapping,
    'owner': GitLabIssue.objects.get().owner_id,
}))
`);
      expect(result).toEqual({ queued: true, workspace_mapping_preserved: true, owner: Number(id) });
      await page.goto('/workspaces/settings/integrations/');
      await expect(page.locator('#gitlab-sync-status')).toContainText('Queued');
      await syncGitLab(); await page.goto(`/projects/${id}/`);
      await expect(page.getByLabel('GitLab title prefix')).toHaveValue('Portal');
      await expect(gitlabRows(page)).toHaveAttribute('data-state', 'in-progress');
      await expect(page.getByLabel('Done labels')).toHaveCount(0);
    } finally { await api.close(); }
  });

  test('GitLab workflow uses configurable labels and historical work cycles without inventing dates', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const projectId = await page.locator('.project-group').first().getAttribute('data-project-id');
      const date = days => new Date(Date.now() + days * 86400000).toISOString();
      api.issues = [
        api.issue(1, 'Portal: Two cycles', { labels: ['WIP', 'Ready'] }),
        api.issue(2, 'Portal: Closed', { state: 'closed', closed_at: date(-1) }),
        api.issue(3, 'Portal: Start unknown', { labels: ['WIP'] }),
      ];
      api.events['101:1:resource_label_events'] = [
        { id: 1, action: 'add', label: { name: 'WIP' }, created_at: date(-10) },
        { id: 2, action: 'add', label: { name: 'Ready' }, created_at: date(-6) },
        { id: 3, action: 'remove', label: { name: 'Ready' }, created_at: date(-5) },
        { id: 4, action: 'add', label: { name: 'Ready' }, created_at: date(-2) },
      ];
      await connectGitLab(page, api);
      await page.getByLabel('In-progress labels').fill('WIP');
      await page.getByLabel('Done labels').fill('Ready');
      await page.getByRole('button', { name: 'Save GitLab workflow', exact: true }).click();
      await bindGitLab(page, projectId, 'Portal');
      await syncGitLab(); await page.reload();
      const cycles = gitlabRows(page).filter({ hasText: 'Two cycles' });
      await expect(cycles).toHaveAttribute('data-state', 'done');
      await expect(cycles.locator('[data-start]')).toHaveCount(2);
      const intervals = await cycles.locator('[data-start]').evaluateAll(els => els.map(e => ({ start: e.dataset.start, end: e.dataset.end })));
      expect(intervals.every(i => i.start && i.end)).toBe(true);
      await expect(gitlabRows(page).filter({ hasText: 'Closed' })).toHaveAttribute('data-state', 'done');
      await expect(gitlabRows(page).filter({ hasText: 'Closed' }).locator('[data-start]')).toHaveAttribute('data-start', '');
      await expect(gitlabRows(page).filter({ hasText: 'Start unknown' })).toHaveAttribute('data-state', 'in-progress');
      await expect(gitlabRows(page).filter({ hasText: 'Start unknown' })).toContainText('Timing unknown');
      await syncGitLab(); await page.reload();
      await expect(cycles.locator('[data-start]')).toHaveCount(2);
      // Remapping replays existing historical events, not a transition at save time.
      await page.goto('/workspaces/gitlab/');
      await page.getByLabel('Done labels').fill('WIP');
      await page.getByRole('button', { name: 'Save GitLab workflow', exact: true }).click();
      await syncGitLab(); await page.goto(`/projects/${projectId}/`);
      await expect(cycles.locator('[data-start]')).toHaveCount(1);
      await expect(cycles.locator('[data-start]')).toHaveAttribute('data-start', '');
    } finally { await api.close(); }
  });

  test('GitLab workflow ignores transitions newer than its source snapshot and honors workspace rules', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const id = await page.locator('.project-group').first().getAttribute('data-project-id');
      const date = days => new Date(Date.now() + days * 86400000).toISOString();
      api.issues = [api.issue(1, 'Portal: Concurrent workflow', { labels: ['In Development'], updated_at: date(-4) })];
      api.events['101:1:resource_label_events'] = [
        { id: 1, action: 'add', label: { name: 'In Development' }, created_at: date(-5) },
        { id: 2, action: 'add', label: { name: 'Next Deployment' }, created_at: date(-3) },
      ];
      await connectGitLab(page, api); await bindGitLab(page, id, 'Portal'); await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveAttribute('data-state', 'in-progress');
      await expect(gitlabRows(page).locator('[data-end]')).toHaveAttribute('data-end', '');
      // Next snapshot catches up, producing the real finish.
      api.issues[0].labels.push('Next Deployment'); api.issues[0].updated_at = date(0);
      await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveAttribute('data-state', 'done');
      const end = await gitlabRows(page).locator('[data-end]').getAttribute('data-end');
      api.issues[0].state = 'closed'; api.issues[0].closed_at = date(-1);
      api.events['101:1:resource_state_events'] = [{ id: 3, state: 'closed', created_at: date(-1) }];
      await syncGitLab(); await page.reload();
      await expect(gitlabRows(page).locator('[data-end]')).toHaveAttribute('data-end', end);
      api.issues[0].state = 'opened'; api.issues[0].closed_at = null;
      api.events['101:1:resource_state_events'].push({ id: 4, state: 'reopened', created_at: date(0) });
      await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveAttribute('data-state', 'done');
      await page.goto('/workspaces/settings/integrations/');
      await page.getByLabel('Done labels').fill('Something else');
      await page.getByRole('button', { name: 'Save GitLab workflow', exact: true }).click();
      await syncGitLab(); await page.goto(`/projects/${id}/`);
      await expect(gitlabRows(page)).toHaveAttribute('data-state', 'in-progress');
    } finally { await api.close(); }
  });

  test('GitLab project issues show readable dates and full-size text', async ({ appPage: page }, testInfo) => {
    const api = await fakeGitLab();
    try {
      const id = await page.locator('.project-group').first().getAttribute('data-project-id');
      api.issues = [
        api.issue(1, 'Portal: Several work cycles with a longer issue title that should remain readable', { labels: ['In Development', 'Next Deployment'] }),
        api.issue(2, 'Portal: Same-day work', { labels: ['In Development', 'Next Deployment'] }),
        api.issue(3, 'Portal: Finish only', { state: 'closed', closed_at: '2025-08-04T23:30:00Z' }),
        api.issue(4, 'Portal: Ongoing work', { labels: ['In Development'] }),
        api.issue(5, 'Portal: Unknown dates', { labels: ['In Development'] }),
      ];
      api.events['101:1:resource_label_events'] = [
        { id: 1, action: 'add', label: { name: 'In Development' }, created_at: '2025-07-23T23:30:00Z' },
        { id: 2, action: 'add', label: { name: 'Next Deployment' }, created_at: '2025-07-25T01:00:00Z' },
        { id: 3, action: 'remove', label: { name: 'Next Deployment' }, created_at: '2025-07-26T08:00:00Z' },
        { id: 4, action: 'add', label: { name: 'Next Deployment' }, created_at: '2025-07-27T12:00:00Z' },
      ];
      api.events['101:2:resource_label_events'] = [
        { id: 1, action: 'add', label: { name: 'In Development' }, created_at: '2025-08-01T08:00:00Z' },
        { id: 2, action: 'add', label: { name: 'Next Deployment' }, created_at: '2025-08-01T11:00:00Z' },
      ];
      api.events['101:4:resource_label_events'] = [
        { id: 1, action: 'add', label: { name: 'In Development' }, created_at: '2025-08-06T08:00:00Z' },
      ];
      await connectGitLab(page, api); await bindGitLab(page, id, 'Portal'); await syncGitLab(); await page.reload();
      await page.locator('.lang-switch button[value="de"]').click();
      const section = page.locator('#gitlab-project');
      const cycles = gitlabRows(page).filter({ hasText: 'Several work cycles' });
      await expect(cycles).toContainText('24.07.2025 – 25.07.2025');
      await expect(cycles).toContainText('26.07.2025 – 27.07.2025');
      await expect(gitlabRows(page).filter({ hasText: 'Same-day work' }).locator('[data-start]')).toHaveText('01.08.2025');
      await expect(gitlabRows(page).filter({ hasText: 'Finish only' })).toContainText('Erledigt am 05.08.2025');
      await expect(gitlabRows(page).filter({ hasText: 'Ongoing work' })).toContainText('06.08.2025 – Laufend');
      await expect(gitlabRows(page).filter({ hasText: 'Unknown dates' })).toContainText('Zeitpunkte unbekannt');
      await expect(section.locator('[data-gitlab-summary]')).toHaveAttribute('data-total', '5');
      await expect(section.locator('[data-state="done"][data-count]')).toHaveText('3 erledigt');
      await expect(section.locator('[data-state="in-progress"][data-count]')).toHaveText('2 in Bearbeitung');
      await expect(section).not.toContainText('keine Aufwandsschätzung');
      expect(await section.innerText()).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
      await expect(section.getByRole('columnheader', { name: 'In Projekt verschieben', exact: true })).toHaveCount(0);
      await expect(page.locator('#gitlab-issues select')).toHaveCount(0);
      for (const locator of [cycles.locator('a'), cycles.locator('[data-start]').first(), cycles.getByRole('button', { name: 'Issue-Aktionen', exact: true })]) {
        expect(await locator.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      }
      await section.screenshot({ path: testInfo.outputPath('gitlab-issues-readable-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const actions = cycles.getByRole('button', { name: 'Issue-Aktionen', exact: true });
      await actions.scrollIntoViewIfNeeded();
      await expect(actions).toBeVisible();
      await actions.click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      await menu.getByRole('menuitem', { name: 'In anderes Projekt verschieben …', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Issue verschieben', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Several work cycles');
      expect(await dialog.getByLabel('Zielprojekt', { exact: true }).evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      expect(await dialog.locator('.modal-box').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await dialog.screenshot({ path: testInfo.outputPath('gitlab-move-dialog-mobile.png'), animations: 'disabled' });
      await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(actions).toBeFocused();
    } finally { await api.close(); }
  });

  test('GitLab execution spans inclusive local day cells including short and finish-only work', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const projectId = await page.locator('.project-group').first().getAttribute('data-project-id');
      const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
      const startDay = day(-5);
      const localToday = await gitlabDB(`
from django.utils import timezone
print(json.dumps(timezone.localdate().isoformat()))
`);
      const cases = [
        { name: 'Short work', start: `${startDay}T12:00:00Z`, end: `${startDay}T12:05:00Z`, first: startDay, last: startDay },
        // Both UTC timestamps fall on the next local day in Europe/Berlin.
        { name: 'UTC midnight', start: `${startDay}T23:30:00Z`, end: `${day(-4)}T00:15:00Z`, first: day(-4), last: day(-4) },
        { name: 'Several days', start: `${startDay}T12:00:00Z`, end: `${day(-3)}T15:00:00Z`, first: startDay, last: day(-3) },
        { name: 'Finish only', start: null, end: `${startDay}T23:30:00Z`, first: day(-4), last: day(-4) },
        { name: 'Still running', start: `${startDay}T12:00:00Z`, end: null, first: startDay, last: localToday },
      ];
      api.issues = cases.map((item, index) => {
        const iid = index + 1;
        const labels = !item.start ? [] : item.end ? ['Next Deployment'] : ['In Development'];
        api.events[`101:${iid}:resource_label_events`] = [
          ...(item.start ? [{ id: 1, action: 'add', label: { name: 'In Development' }, created_at: item.start }] : []),
          ...(item.end && item.start ? [{ id: 2, action: 'add', label: { name: 'Next Deployment' }, created_at: item.end }] : []),
        ];
        return api.issue(iid, `Portal: ${item.name}`, {
          labels, ...(item.start ? {} : { state: 'closed', closed_at: item.end }),
        });
      });
      await connectGitLab(page, api); await bindGitLab(page, projectId, 'Portal'); await syncGitLab();
      await page.goto('/');
      await page.locator(`[data-gitlab-summary-trigger="${projectId}"]`).click();
      await page.locator(`[data-gitlab-toggle="${projectId}"]`).click();
      await expect(page.locator('.gitlab-interval')).toHaveCount(cases.length);
      const assertDayCells = async () => {
        const ppd = Number(await page.locator('#grid-scroll').getAttribute('data-px-per-day'));
        const chartStart = await page.locator('#grid-scroll').getAttribute('data-chart-start');
        const daysBetween = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;
        for (const item of cases) {
          const bar = page.locator(`.gitlab-interval[title^="Portal: ${item.name} ·"]`);
          const geometry = await bar.evaluate(el => ({
            x: parseFloat(el.style.left), width: parseFloat(el.style.width),
            transform: getComputedStyle(el).transform, start: el.dataset.start, end: el.dataset.end,
          }));
          expect(geometry.x, item.name).toBeCloseTo(daysBetween(item.first, chartStart) * ppd, 4);
          expect(geometry.width, item.name).toBeCloseTo((daysBetween(item.last, item.first) + 1) * ppd, 4);
          expect(geometry.transform).toBe('none');
          // Snapping must not replace unknown or exact source timestamps.
          expect(geometry.start ? Date.parse(geometry.start) : null).toBe(item.start ? Date.parse(item.start) : null);
          expect(geometry.end ? Date.parse(geometry.end) : null).toBe(item.end ? Date.parse(item.end) : null);
        }
      };
      await assertDayCells();
      await page.locator('#zoom-slider').evaluate(el => {
        el.value = el.max; el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect(page.locator('#grid-scroll')).toHaveAttribute('data-px-per-day', '72');
      await assertDayCells();
    } finally { await api.close(); }
  });

  test('compact GitLab indicators reveal details on demand without adding chart rows', async ({ appPage: page }, testInfo) => {
    const api = await fakeGitLab();
    try {
      const projectId = await page.locator('.project-group').first().getAttribute('data-project-id');
      const rowCount = await page.locator('.chart-row').count();
      api.issues = [api.issue(1, 'Portal: Finished', { state: 'closed' }), api.issue(2, 'Portal: Building', { labels: ['In Development'] })];
      await connectGitLab(page, api); await bindGitLab(page, projectId, 'Portal'); await syncGitLab();
      await page.goto('/');
      const trigger = page.locator(`[data-gitlab-summary-trigger="${projectId}"]`);
      const popover = page.locator(`#gitlab-project-summary-${projectId}`);
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveText('1/2');
      await expect(trigger).toHaveAccessibleName('GitLab · 1/2 done');
      await expect(trigger.locator('svg.gitlab-icon')).toBeVisible();
      await expect(page.locator('.chart-row')).toHaveCount(rowCount);
      await expect(page.locator('.gitlab-summary, .gitlab-summary-content')).toHaveCount(0);
      await expect(popover).not.toBeVisible();
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(popover).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(popover.getByRole('link', { name: '1 in progress', exact: true })).toBeVisible();
      await expect(page.locator('#project-popover')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(popover).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith(`/projects/${projectId}/toggle-collapse/`)),
        page.locator(`.project-group[data-project-id="${projectId}"] .collapse-toggle`).click(),
      ]);
      await page.reload();
      await trigger.click();
      await popover.getByRole('button', { name: 'Show execution timeline', exact: true }).click();
      await expect(page.locator('.chart-row.gitlab-issue')).toHaveCount(2);
      await expect(page.locator('.chart-row.gitlab-issue').first()).toBeVisible();
      await page.reload();
      await expect(page.locator('.chart-row.gitlab-issue').first()).toBeVisible();
      await expect(popover).not.toBeVisible();
      await trigger.click();
      await popover.getByRole('button', { name: 'Hide execution timeline', exact: true }).click();
      await expect(page.locator('.chart-row.gitlab-issue')).toHaveCount(0);
      await expect(page.locator('.chart-row')).toHaveCount(rowCount);
      await page.locator('.lang-btn', { hasText: 'DE' }).click();
      await expect(trigger).toHaveText('1/2');
      await expect(trigger).toHaveAccessibleName('GitLab · 1/2 erledigt');
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await trigger.scrollIntoViewIfNeeded();
        await expect(trigger).toBeInViewport();
        const controls = trigger.locator('xpath=..');
        await expect(controls).toHaveClass(/project-create-actions/);
        const triggerBox = await trigger.boundingBox();
        const taskBox = await controls.getByRole('button', { name: 'Aufgabe hinzufügen', exact: true }).boundingBox();
        expect(triggerBox.y + triggerBox.height / 2).toBeCloseTo(taskBox.y + taskBox.height / 2, 0);
        expect(triggerBox.height).toBeGreaterThanOrEqual(24);
        expect(await trigger.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
        await page.screenshot({ path: testInfo.outputPath(`gitlab-compact-${width}.png`), fullPage: true, animations: 'disabled' });
        await trigger.click();
        await expect(popover).toBeVisible();
        const box = await popover.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(844);
        await page.screenshot({ path: testInfo.outputPath(`gitlab-compact-popover-${width}.png`), fullPage: true, animations: 'disabled' });
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
      }
    } finally { await api.close(); }
  });

  test('GitLab project summaries show issue counts and open persistent state filters', async ({ appPage: page }, testInfo) => {
    const api = await fakeGitLab();
    try {
      const ids = await page.locator('.project-group').evaluateAll(groups => groups.map(group => group.dataset.projectId));
      api.issues = [
        api.issue(1, 'Portal: Closed', { state: 'closed' }),
        api.issue(2, 'Portal: Ready to ship', { labels: ['Next Deployment'] }),
        api.issue(3, 'Portal: Building', { labels: ['In Development'] }),
        api.issue(4, 'Portal: Planned', { labels: ['Ready'] }),
        api.issue(5, 'Portal: Unknown workflow'),
        api.issue(6, 'Reports: Separate project'),
        api.issue(7, 'Unassigned: Not counted'),
      ];
      await connectGitLab(page, api);
      await page.getByLabel('Not-started labels').fill('Ready');
      await page.getByRole('button', { name: 'Save GitLab workflow', exact: true }).click();
      await bindGitLab(page, ids[0], 'Portal');
      await bindGitLab(page, ids[1], 'Reports');
      await syncGitLab();
      const requestsAfterSync = api.requests.length;
      await page.goto('/');
      const trigger = page.locator(`[data-gitlab-summary-trigger="${ids[0]}"]`);
      const summary = page.locator(`.project-group[data-project-id="${ids[0]}"] [data-gitlab-summary]`);
      await expect(trigger).toBeVisible();
      await expect(summary).not.toBeVisible();
      await trigger.click();
      await expect(summary).toBeVisible();
      await expect(summary).toHaveAttribute('data-total', '5');
      for (const [state, count] of [['done', 2], ['in-progress', 1], ['not-started', 1], ['unclassified', 1]]) {
        await expect(summary.locator(`[data-state="${state}"]`)).toHaveAttribute('data-count', String(count));
      }
      await expect(page.locator('.chart-row.gitlab-issue')).toHaveCount(0);
      await expect(page.locator(`.project-group[data-project-id="${ids[2]}"] [data-gitlab-summary]`)).toHaveCount(0);
      const collapse = page.locator(`.project-group[data-project-id="${ids[0]}"] .collapse-toggle`);
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith(`/projects/${ids[0]}/toggle-collapse/`)),
        collapse.click(),
      ]);
      await expect(trigger).toBeVisible();
      await page.reload();
      await expect(trigger).toBeVisible();
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith(`/projects/${ids[0]}/toggle-collapse/`)),
        collapse.click(),
      ]);
      await page.reload();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await trigger.scrollIntoViewIfNeeded();
        await expect(trigger).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath(`gitlab-summary-${width}.png`), fullPage: true, animations: 'disabled' });
      }
      await page.setViewportSize({ width: 1280, height: 844 });
      await trigger.click();
      await summary.getByRole('link', { name: '2 done', exact: true }).click();
      await expect(page).toHaveURL(`/projects/${ids[0]}/?gitlab_state=done#gitlab-issues`);
      await expect(gitlabRows(page)).toHaveCount(2);
      expect(await gitlabRows(page).evaluateAll(rows => rows.map(row => row.dataset.state))).toEqual(['done', 'done']);
      await page.getByRole('link', { name: 'Refresh GitLab issues', exact: true }).click();
      await expect(page).toHaveURL(`/projects/${ids[0]}/?gitlab_state=done#gitlab-issues`);
      await page.reload();
      const detailSummary = page.locator('#gitlab-project [data-gitlab-summary]');
      await expect(detailSummary).toHaveAttribute('data-total', '5');
      await expect(detailSummary.locator('[data-state="done"]')).toHaveAttribute('aria-current', 'page');
      for (const state of ['in-progress', 'not-started', 'unclassified']) {
        await detailSummary.locator(`[data-state="${state}"]`).click();
        await expect(gitlabRows(page)).toHaveCount(1);
        await expect(gitlabRows(page)).toHaveAttribute('data-state', state);
      }
      await detailSummary.getByRole('link', { name: 'All issues (5)', exact: true }).click();
      await expect(gitlabRows(page)).toHaveCount(5);
      await page.goto(`/projects/${ids[1]}/?gitlab_state=done#gitlab-issues`);
      await expect(gitlabRows(page)).toHaveCount(0);
      await expect(page.locator('#gitlab-issues')).toContainText('No GitLab issues match this filter.');
      await expect(page.locator('#gitlab-project [data-gitlab-summary]')).toHaveAttribute('data-total', '1');
      await page.goto(`/projects/${ids[0]}/?gitlab_state=invalid`);
      await expect(gitlabRows(page)).toHaveCount(5);
      await page.locator('.lang-btn', { hasText: 'DE' }).click();
      await expect(detailSummary.locator('[data-state="done"]')).toHaveText('2 erledigt');
      await detailSummary.locator('[data-state="in-progress"]').click();
      await expect(gitlabRows(page)).toHaveCount(1);
      await expect(detailSummary.locator('[data-state="in-progress"]')).toHaveAttribute('aria-current', 'page');
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`gitlab-summary-details-de-${width}.png`), fullPage: true, animations: 'disabled' });
      }
      expect(api.requests.length).toBe(requestsAfterSync);
    } finally { await api.close(); }
  });

  test('GitLab project summaries identify stale and disconnected cached counts', async ({ appPage: page }, testInfo) => {
    const api = await fakeGitLab();
    try {
      const projectId = await page.locator('.project-group').first().getAttribute('data-project-id');
      api.issues = [api.issue(1, 'Portal: Cached', { labels: ['In Development'] })];
      await connectGitLab(page, api); await bindGitLab(page, projectId, 'Portal'); await syncGitLab();
      await page.goto('/');
      const group = page.locator(`.project-group[data-project-id="${projectId}"]`);
      const trigger = group.locator('[data-gitlab-summary-trigger]');
      const icon = trigger.locator('svg.gitlab-icon');
      const popover = page.locator(`#gitlab-project-summary-${projectId}`);
      await expect(trigger).toHaveAttribute('data-cache-warning', 'false');
      const freshColor = await icon.evaluate(el => getComputedStyle(el).color);
      await expect(trigger).toHaveAttribute('title', /Last successful sync/);
      api.status = 503;
      await syncGitLab();
      await page.reload();
      await expect(trigger).toHaveAttribute('data-cache-warning', 'true');
      await expect(trigger).toHaveText('0/1');
      await expect(trigger.locator('svg')).toHaveCount(1);
      expect(await icon.evaluate(el => getComputedStyle(el).color)).not.toBe(freshColor);
      await expect(trigger).toHaveAttribute('title', /GitLab data may be stale\./);
      await expect(trigger).toHaveAccessibleDescription(/GitLab data may be stale\./);
      await trigger.click();
      await expect(popover).toContainText('GitLab data may be stale.');
      await expect(popover).toContainText('Last successful sync');
      const syncTime = await popover.locator('time').textContent();
      expect(await trigger.getAttribute('title')).toContain(syncTime);
      await page.screenshot({ path: testInfo.outputPath('gitlab-stale-icon.png'), fullPage: true, animations: 'disabled' });
      await page.goto('/workspaces/settings/integrations/');
      await page.getByRole('button', { name: 'Disconnect GitLab', exact: true }).click();
      await page.goto('/');
      await expect(trigger).toHaveAttribute('data-cache-warning', 'true');
      await expect(trigger.locator('svg')).toHaveCount(1);
      await expect(trigger).toHaveAttribute('title', /GitLab is disconnected\./);
      await expect(trigger).not.toHaveAttribute('title', /may be stale/);
      await expect(group.locator('[data-gitlab-summary]')).toHaveAttribute('data-total', '1');
      api.status = 200;
      await connectGitLab(page, api); await syncGitLab();
      await page.goto('/');
      await expect(trigger).toHaveAttribute('data-cache-warning', 'false');
      expect(await icon.evaluate(el => getComputedStyle(el).color)).toBe(freshColor);
      await gitlabDB("GitLabConnection.objects.update(last_success=None)\nprint('true')");
      await page.reload();
      await expect(trigger).toHaveAttribute('title', /No successful sync yet\./);
      await trigger.click();
      await expect(popover).toContainText('No successful sync yet.');
      await page.locator('.lang-btn', { hasText: 'DE' }).click();
      await expect(trigger).toHaveAttribute('title', /Noch keine erfolgreiche Synchronisierung\./);
      await expect(trigger).toHaveAccessibleDescription(/Die GitLab-Daten sind möglicherweise veraltet\./);
      await expect(trigger.locator('svg')).toHaveCount(1);
      await trigger.click();
      await expect(popover).toContainText('Noch keine erfolgreiche Synchronisierung.');
      await page.screenshot({ path: testInfo.outputPath('gitlab-stale-icon-de.png'), fullPage: true, animations: 'disabled' });
    } finally { await api.close(); }
  });

  test('GitLab execution overlay survives patches without changing task geometry or interactions', async ({ appPage: page }, testInfo) => {
    const api = await fakeGitLab();
    try {
      const projectId = await page.locator('.project-group').first().getAttribute('data-project-id');
      const date = days => new Date(Date.now() + days * 86400000).toISOString();
      api.issues = [api.issue(1, 'Portal: Execution', { labels: ['Next Deployment'] }), api.issue(2, 'Portal: Undated')];
      api.events['101:1:resource_label_events'] = [
        { id: 1, action: 'add', label: { name: 'In Development' }, created_at: date(-5) },
        { id: 2, action: 'add', label: { name: 'Next Deployment' }, created_at: date(-1) },
      ];
      await connectGitLab(page, api); await bindGitLab(page, projectId, 'Portal'); await syncGitLab();
      await page.goto('/');
      const before = await page.locator('.bar').evaluateAll(bars => bars.map(b => ({ id: b.id, start: b.dataset.start, end: b.dataset.end })));
      const toggle = page.locator(`[data-gitlab-toggle="${projectId}"]`);
      await expect(toggle).toHaveCount(1);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await page.locator(`[data-gitlab-summary-trigger="${projectId}"]`).click();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.chart-row.gitlab-issue')).toHaveCount(2);
      await expect(page.locator('.gitlab-interval')).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath('gitlab-overlay.png'), fullPage: true });
      await expect(page.locator('.chart-row.gitlab-issue').filter({ hasText: 'Timing unknown' })).toHaveCount(1);
      expect(await page.locator('.gitlab-timing').evaluate(el => {
        const sc = document.getElementById('grid-scroll');
        return el.getBoundingClientRect().left >= sc.getBoundingClientRect().left + parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'));
      })).toBe(true);
      // Read-only source rows must not create tasks or become draggable task bars.
      await page.locator('.gitlab-interval').click();
      expect(await page.locator('.bar').evaluateAll(bars => bars.map(b => ({ id: b.id, start: b.dataset.start, end: b.dataset.end })))).toEqual(before);
      await page.reload(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await page.locator('#zoom-slider').evaluate(el => {
        el.value = el.max; el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect(page.locator('#grid-scroll')).toHaveAttribute('data-px-per-day', '72');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      // Explicitly exercise the client-side recalculation as well as initial render.
      const arrowsAligned = () => page.evaluate(() => {
        nano.recalcArrows();
        return [...document.querySelectorAll('#arrows .hit')].every(path => {
          if (getComputedStyle(path).display === 'none') return true;
          const [a, b] = path.dataset.dep.split('-');
          const svgTop = path.ownerSVGElement.getBoundingClientRect().top;
          const first = path.getPointAtLength(0), last = path.getPointAtLength(path.getTotalLength());
          const center = id => { const r = document.getElementById(`bar-${id}`).getBoundingClientRect(); return r.y + r.height / 2; };
          return Math.abs(first.y + svgTop - center(a)) < 2 && Math.abs(last.y + svgTop - center(b)) < 2;
        });
      });
      expect(await arrowsAligned()).toBe(true);
      await page.locator(`[data-gitlab-summary-trigger="${projectId}"]`).click();
      await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(await arrowsAligned()).toBe(true);
    } finally { await api.close(); }
  });

  test('GitLab failures preserve cached ownership and authentication can be repaired', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const projectId = await page.locator('.project-group').first().getAttribute('data-project-id');
      api.issues = [api.issue(1, 'Portal: Keep ownership')];
      await connectGitLab(page, api); await bindGitLab(page, projectId, 'Portal');
      await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveCount(1);
      await gitlabDB(`
from datetime import timedelta
from django.utils import timezone
GitLabConnection.objects.update(last_success=timezone.now() - timedelta(hours=1))
print('true')
`);
      await page.reload();
      await expect(page.locator('#gitlab-project')).toContainText('stale');
      api.status = 401;
      await syncGitLab(); await page.goto('/workspaces/gitlab/');
      await expect(page.locator('#gitlab-sync-status')).toContainText('authentication-failed');
      const count = api.requests.length;
      await syncGitLab(); expect(api.requests.length).toBe(count);
      await page.goto(`/projects/${projectId}/`);
      await expect(gitlabRows(page)).toHaveCount(1);
      await expect(page.locator('#gitlab-project')).toContainText('stale');
      api.status = 200;
      await connectGitLab(page, api); await syncGitLab();
      await page.reload();
      await expect(page.locator('#gitlab-sync-status')).toContainText('Up to date');
      await page.goto(`/projects/${projectId}/`);
      await expect(gitlabRows(page)).toHaveCount(1);
      expect(api.requests.some(r => r.query.includes('updated_after='))).toBe(true);
    } finally { await api.close(); }
  });

  test('GitLab rejects competing prefixes and manual issue transfers persist', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const ids = await page.locator('.project-group').evaluateAll(groups => groups.map(g => Number(g.dataset.projectId)));
      api.issues = [api.issue(1, 'Portal: Transfer'), api.issue(2, 'Portal: Leave this issue here')];
      await connectGitLab(page, api); await bindGitLab(page, ids[0], 'Portal'); await syncGitLab();
      await page.goto(`/projects/${ids[1]}/`);
      await page.getByText('GitLab project settings', { exact: true }).click();
      await page.getByLabel('GitLab title prefix').fill('PORTAL');
      await page.getByRole('button', { name: 'Save GitLab project settings', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Another active project');
      await page.goto(`/projects/${ids[0]}/`);
      await expect(page.locator('#gitlab-issues select')).toHaveCount(0);
      const actions = gitlabRows(page).filter({ hasText: 'Portal: Transfer' }).getByRole('button', { name: 'Issue actions', exact: true });
      await expect(actions).toBeVisible();
      await actions.focus(); await actions.press('Enter');
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).not.toBeVisible();
      await expect(actions).toBeFocused();
      await actions.press('Enter');
      await expect(menu).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(menu).not.toBeVisible();
      const openMoveDialog = async () => {
        await actions.click();
        await menu.getByRole('menuitem', { name: 'Move to another project…', exact: true }).click();
      };
      await openMoveDialog();
      const dialog = page.getByRole('dialog', { name: 'Move issue', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Portal: Transfer');
      await expect(dialog).toContainText('API Migration');
      const destination = dialog.getByLabel('Destination project', { exact: true });
      const move = dialog.getByRole('button', { name: 'Move issue', exact: true });
      await expect(destination).toHaveValue('');
      await expect(move).toBeDisabled();
      await destination.selectOption(String(ids[1]));
      await expect(move).toBeEnabled();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(actions).toBeFocused();
      await expect(gitlabRows(page)).toHaveCount(2);
      await openMoveDialog();
      await expect(destination).toHaveValue('');
      await expect(move).toBeDisabled();
      await destination.selectOption(String(ids[1]));
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await openMoveDialog();
      await expect(destination).toHaveValue('');
      await expect(move).toBeDisabled();
      await destination.selectOption(String(ids[1]));
      await expect(move).toBeEnabled();
      await destination.selectOption('');
      await expect(move).toBeDisabled();
      await destination.selectOption(String(ids[1]));
      await move.click();
      await expect(page).toHaveURL(`/projects/${ids[1]}/`);
      await syncGitLab(); await page.reload(); await expect(gitlabRows(page)).toHaveCount(1);
      await page.goto(`/projects/${ids[0]}/`); await expect(gitlabRows(page)).toHaveCount(1);
      await expect(gitlabRows(page)).toContainText('Leave this issue here');
    } finally { await api.close(); }
  });

  test('GitLab collection respects the current source scope even for cached unassigned issues', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const id = await page.locator('.project-group').first().getAttribute('data-project-id');
      api.issues = [api.issue(1, 'Portal: Removed source'), api.issue(1, 'Portal: Selected source', { project_id: 102 })];
      await connectGitLab(page, api); await syncGitLab();
      await page.getByLabel('GitLab project IDs').fill('102');
      await page.getByRole('button', { name: 'Save GitLab connection', exact: true }).click();
      await bindGitLab(page, id, 'Portal'); await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveCount(1);
      await expect(gitlabRows(page)).toContainText('Selected source');
    } finally { await api.close(); }
  });

  test('GitLab transient failures back off durably and never follow credential-bearing redirects', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    const other = await fakeGitLab();
    try {
      await connectGitLab(page, api);
      api.status = 503;
      const delay = () => gitlabDB(`
from django.utils import timezone
connection = GitLabConnection.objects.get()
print(json.dumps((connection.next_run - timezone.now()).total_seconds()))
`);
      await syncGitLab(); const first = await delay();
      await syncGitLab(); const second = await delay();
      expect(second).toBeGreaterThan(first * 1.8);
      api.status = 429; api.retryAfter = '600';
      await syncGitLab(); expect(await delay()).toBeGreaterThan(590);
      api.status = 302; api.redirectTo = other.url; api.retryAfter = '';
      await syncGitLab();
      expect(other.requests).toHaveLength(0);
      await page.reload();
      await expect(page.locator('#gitlab-sync-status')).toContainText('request-failed');
    } finally { await api.close(); await other.close(); }
  });

  test('GitLab groups discover projects and source unavailability does not erase assignments', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const projectId = await page.locator('.project-group').first().getAttribute('data-project-id');
      api.groups[9] = [101, 103];
      api.issues = [api.issue(1, 'Portal: Group issue', { project_id: 103 })];
      await connectGitLab(page, api);
      await page.getByLabel('GitLab project IDs').fill('');
      await page.getByLabel('GitLab group IDs').fill('9');
      await page.getByRole('button', { name: 'Save GitLab connection', exact: true }).click();
      await bindGitLab(page, projectId, 'Portal'); await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveCount(1);
      api.omitFromList = true;
      api.failures['/api/v4/projects/103/issues/1'] = 404;
      await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveCount(1);
      await expect(gitlabRows(page)).toContainText('Source unavailable');
      delete api.failures['/api/v4/projects/103/issues/1'];
      api.issues[0].state = 'closed';
      await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveAttribute('data-state', 'done');
      await expect(gitlabRows(page)).not.toContainText('Source unavailable');
    } finally { await api.close(); }
  });

  test('GitLab stale sync cannot claim issues after the collector changes and leases prevent duplicate polling', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    let release;
    let firstSync;
    try {
      const ids = await page.locator('.project-group').evaluateAll(groups => groups.map(g => Number(g.dataset.projectId)));
      api.issues = [api.issue(1, 'Portal: Race')];
      await connectGitLab(page, api); await bindGitLab(page, ids[0], 'Portal');
      let reached;
      const started = new Promise(resolve => { reached = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      api.beforeRequest = async url => {
        if (url.pathname.endsWith('/resource_state_events')) { reached(); await wait; }
      };
      firstSync = syncGitLab();
      await started;
      const count = api.requests.length;
      await syncGitLab();
      expect(api.requests.length).toBe(count);
      expect(await postForm(page, `/projects/${ids[0]}/set-completed/`, {})).toBe(200);
      await bindGitLab(page, ids[1], 'Portal');
      release(); await firstSync;
      await page.goto(`/projects/${ids[0]}/`); await expect(gitlabRows(page)).toHaveCount(0);
      await syncGitLab(); await page.goto(`/projects/${ids[1]}/`); await expect(gitlabRows(page)).toHaveCount(1);
    } finally { if (release) release(); if (firstSync) await firstSync; await api.close(); }
  });

  test('GitLab sync retries SQLite result writes without repeating API requests', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    let release;
    let syncing;
    try {
      const id = await page.locator('.project-group').first().getAttribute('data-project-id');
      api.issues = [api.issue(1, 'Portal: Locked write')];
      await connectGitLab(page, api); await bindGitLab(page, id, 'Portal');
      let reached;
      const started = new Promise(resolve => { reached = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      api.beforeRequest = async url => {
        if (url.pathname.endsWith('/resource_state_events')) { reached(); await wait; }
      };
      syncing = syncGitLab(); await started;
      const count = api.requests.length;
      const lock = await holdSQLiteWriteLock();
      release(); await lock.done; await syncing;
      expect(api.requests.length).toBe(count);
      await page.reload(); await expect(gitlabRows(page)).toHaveCount(1);
    } finally { if (release) release(); if (syncing) await syncing; await api.close(); }
  });

  test('GitLab project workspace moves retire private source associations', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const ids = await page.locator('.project-group').evaluateAll(groups => groups.map(g => Number(g.dataset.projectId)));
      api.issues = [api.issue(1, 'Portal: Original workspace only')];
      await connectGitLab(page, api); await bindGitLab(page, ids[0], 'Portal'); await syncGitLab();
      const target = await gitlabDB(`
from django.contrib.auth.models import User
target = Membership.objects.get(user__username='pm2').workspace
Membership.objects.get_or_create(workspace=target, user=User.objects.get(username='demo'), defaults={'role': 'pm'})
print(json.dumps(target.pk))
`);
      await page.goto('/'); await page.locator(`#proj-${ids[0]} .name`).click();
      await expect(page.locator('#project-popover')).toContainText('Private issue data will not move');
      expect(await postForm(page, `/projects/${ids[0]}/move-workspace/`, { workspace_id: String(target) })).toBe(200);
      await bindGitLab(page, ids[1], 'Portal'); await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveCount(0);
      expect(await postForm(page, `/workspaces/${target}/switch/`, {})).toBe(200);
      await page.goto(`/projects/${ids[0]}/`);
      await expect(page.locator('#gitlab-project')).toHaveCount(0);
      expect(await page.content()).not.toContain('Original workspace only');
    } finally { await api.close(); }
  });

  test('GitLab input validation rejects unsafe origins without reflecting tokens', async ({ appPage: page }) => {
    await page.goto('/workspaces/gitlab/');
    for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://[invalid']) {
      const status = await postForm(page, '/workspaces/gitlab/', { action: 'connect', instance_url: url, token: 'never-reflect-this', project_ids: '101' });
      expect(status).toBe(200);
      await expect(page.locator('#gitlab-connection-status')).toContainText('Disconnected');
    }
    const response = await page.request.post('/workspaces/gitlab/', { form: { action: 'connect', instance_url: 'http://example.com', token: 'never-reflect-this', project_ids: '101', csrfmiddlewaretoken: await page.locator('[name=csrfmiddlewaretoken]').first().inputValue() }, headers: { Referer: page.url() } });
    expect(await response.text()).not.toContain('never-reflect-this');
  });

  test('GitLab deletion retires ownership and private metadata stays workspace scoped', async ({ appPage: page }) => {
    const api = await fakeGitLab();
    try {
      const ids = await page.locator('.project-group').evaluateAll(groups => groups.map(g => Number(g.dataset.projectId)));
      api.issues = [api.issue(1, 'Portal: Private issue')];
      await connectGitLab(page, api); await bindGitLab(page, ids[0], 'Portal'); await syncGitLab();
      await page.reload();
      const roadmap = await enableRoadmap(page);
      const publicResponse = await page.request.get(roadmap);
      expect(publicResponse.status()).toBe(200);
      expect(await publicResponse.text()).not.toContain('Private issue');
      expect(await publicResponse.text()).not.toContain(api.url);
      await postForm(page, `/projects/${ids[0]}/delete/`, {});
      await bindGitLab(page, ids[1], 'Portal'); await syncGitLab(); await page.reload();
      await expect(gitlabRows(page)).toHaveCount(0);
      expect(await gitlabDB(`
retired = GitLabIssue.objects.get(retired=True)
print(json.dumps(not retired.title and not retired.intervals and not retired.events.exists()))
`)).toBe(true);
      await signInAs(page, 'member1');
      expect((await page.request.get('/workspaces/gitlab/')).status()).toBe(403);
      expect(await postForm(page, `/projects/${ids[1]}/gitlab/`, { prefix: 'Other', collect: 'on', fallback: 'unclassified' })).toBe(403);
      await signInAs(page, 'pm2');
      expect((await page.request.get(`/projects/${ids[1]}/`)).status()).toBe(404);
      await page.goto('/workspaces/gitlab/');
      expect(await page.content()).not.toContain('Private issue');
      await expect(page.locator('#gitlab-connection-status')).toContainText('Disconnected');
    } finally { await api.close(); }
  });
});

test.describe('e2e setup', () => {
  test('worker databases and subprocesses are isolated from other Django servers', async ({ appPage: page, browser }) => {
    const { stdout } = await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'shell', '-c', `
import json
from django.conf import settings
from pathlib import Path
print(json.dumps({'database': str(Path(settings.DATABASES['default']['NAME']).resolve())}))
`], {
      cwd: path.resolve(__dirname, '../..'),
      env: djangoEnv({ DJANGO_SETTINGS_MODULE: 'config.settings' }),
    });
    const database = JSON.parse(stdout.trim().split('\n').at(-1)).database;
    expect(path.resolve(database)).not.toBe(path.resolve(__dirname, '../../db.e2e.sqlite3'));
    expect(database.startsWith(tmpdir() + path.sep)).toBe(true);
    const { startWorkerServer } = require('../server');
    const otherServer = await startWorkerServer();
    const otherContext = await browser.newContext({ baseURL: otherServer.url });
    try {
      expect(otherServer.env.DJANGO_DB_PATH).not.toBe(database);
      expect(new URL(otherServer.url).port).not.toBe(new URL(page.url()).port);
      const other = await otherContext.newPage();
      await login(other);
      await page.goto('/profile/');
      await page.getByLabel('First name', { exact: true }).fill('Primary worker');
      await page.getByRole('button', { name: 'Save profile', exact: true }).click();
      await reset(other.request);
      await page.reload();
      await expect(page.getByLabel('First name', { exact: true })).toHaveValue('Primary worker');
      await login(other);
      await other.goto('/profile/');
      await other.getByLabel('First name', { exact: true }).fill('Other worker');
      await other.getByRole('button', { name: 'Save profile', exact: true }).click();
      await reset(page.request);
      await other.reload();
      await expect(other.getByLabel('First name', { exact: true })).toHaveValue('Other worker');
    } finally {
      await otherContext.close();
      await otherServer.stop();
    }
  });

  test('e2e seed uses fast password hashing while normal settings remain secure', async ({ appPage: page }) => {
    const { stdout } = await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'shell', '-c', `
import json
from django.conf import settings
from django.contrib.auth import get_user_model
print(json.dumps({'default_hasher': settings.PASSWORD_HASHERS[0], 'seed_algorithm': get_user_model().objects.get(username='demo').password.split('$', 1)[0]}))
`], {
      cwd: path.resolve(__dirname, '../..'),
      env: djangoEnv({ DJANGO_SETTINGS_MODULE: 'config.settings' }),
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    expect(result.default_hasher).toBe('django.contrib.auth.hashers.PBKDF2PasswordHasher');
    expect(result.seed_algorithm).toBe('md5');
    await expect(page.locator('.sidebar-user .user-name')).toHaveText('demo');
  });

  test('fast e2e settings refuse normal databases and missing safety opt-ins', async () => {
    const safe = {
      ...process.env,
      PYTHONPATH: 'src',
      DJANGO_SECRET_KEY: 'settings-safety-test-only',
      DJANGO_DEBUG: 'true',
      DJANGO_ENABLE_TEST_RESET: 'true',
      DJANGO_ALLOW_INSECURE_SEED: 'true',
      DJANGO_DB_PATH: 'db.e2e.sqlite3',
    };
    for (const override of [
      { DJANGO_DEBUG: 'false' },
      { DJANGO_ENABLE_TEST_RESET: 'false' },
      { DJANGO_ALLOW_INSECURE_SEED: 'false' },
      { DJANGO_DB_PATH: 'db.sqlite3' },
      { DJANGO_DB_PATH: '' },
    ]) {
      await expect(promisify(execFile)('uv', ['run', 'python', '-c', 'import config.settings_e2e'], {
        cwd: path.resolve(__dirname, '../..'), env: { ...safe, ...override },
      })).rejects.toMatchObject({ stderr: expect.stringContaining('config.settings_e2e requires') });
    }
  });

  test('routine fixture login still requires a valid password and CSRF token', async ({ page, request }) => {
    await reset(request);
    const form = await page.request.get('/accounts/login/');
    const csrf = (await form.text()).match(/name="csrfmiddlewaretoken"[^>]*value="([^"]+)"/)[1];
    const missingToken = await page.request.post('/accounts/login/', {
      form: { username: 'demo', password: 'demo' }, maxRedirects: 0,
    });
    expect(missingToken.status()).toBe(403);
    const wrongPassword = await page.request.post('/accounts/login/', {
      form: { username: 'demo', password: 'wrong', csrfmiddlewaretoken: csrf },
      headers: { Referer: form.url() }, maxRedirects: 0,
    });
    expect(wrongPassword.status()).toBe(200);
    expect((await page.request.get('/', { maxRedirects: 0 })).status()).toBe(302);
    await login(page);
    await expect(page.locator('.sidebar-user .user-name')).toHaveText('demo');
  });

  test('routine fixture login uses the real session without navigating through the login form', async ({ page, request }) => {
    await reset(request);
    const navigations = [];
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        navigations.push(new URL(request.url()).pathname);
      }
    });
    await login(page);
    await expect(page.locator('#grid-scroll')).toBeVisible();
    await expect(page.locator('.sidebar-user .user-name')).toHaveText('demo');
    expect(navigations).toEqual(['/']);
    expect((await page.context().cookies()).find(cookie => cookie.name === 'nano_pm_sessionid')?.httpOnly).toBe(true);
    await page.reload();
    await expect(page.locator('.sidebar-user .user-name')).toHaveText('demo');
  });
});

test.describe('workload estimates', () => {
  test('workload save confirmation is a dismissible German toast, not inline text', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/profile/workload/');
    await page.locator('.lang-switch button[value="de"]').click();
    const inputs = page.locator('[data-workload-percentage]');
    await inputs.nth(0).fill('30');
    await inputs.nth(1).fill('60');
    await inputs.nth(2).fill('10');
    await page.getByRole('button', { name: 'Schätzung speichern', exact: true }).click();
    const toast = page.locator('#toast-slot .nano-toast');
    await expect(toast).toContainText('Schätzung gespeichert.');
    await expect(page.locator('#workload-content')).not.toContainText('Schätzung gespeichert.');
    await toast.getByRole('button').click();
    await expect(toast).toHaveCount(0);
    await inputs.nth(0).fill('20');
    await page.locator('#workload-form').evaluate(form => form.requestSubmit());
    await expect(page.locator('#workload-content [role=alert]')).toBeVisible();
    await expect(toast).toHaveCount(0);
  });
  test('workload check-in opens empty with adjacent previous values and saves a fresh estimate', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await submitWorkloadExample(page);
    await ageWorkloadCheckin();
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'How is your work split right now?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Use previous 30%', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Use previous 40%', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Maintenance percentage', { exact: true })).toHaveValue('');
    await expect(dialog.getByLabel('Project work: API Migration percentage', { exact: true })).toHaveValue('');
    await expect(dialog.locator('[data-workload-center-value]')).toHaveText('0%');
    await expect(dialog.locator('[data-workload-slice]:visible')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Still accurate' })).toHaveCount(0);
    const submit = dialog.getByRole('button', { name: 'Submit estimate', exact: true });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel('Maintenance percentage', { exact: true }).fill('20');
    await dialog.getByLabel('Project work percentage', { exact: true }).fill('80');
    await expect(submit).toBeDisabled(); // Empty is not an explicit zero.
    await dialog.getByLabel('Meetings percentage', { exact: true }).fill('0');
    await dialog.getByLabel('Project work: API Migration percentage', { exact: true }).fill('50');
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#toast-slot .nano-toast')).toContainText('Estimate saved.');
    await page.reload();
    await expect(page.locator('#workload-checkin-dialog')).toHaveCount(0);
    await page.goto('/profile/workload/');
    await expect(page.getByLabel('Maintenance percentage', { exact: true })).toHaveValue('20');
    await expect(page.getByLabel('Project work: API Migration percentage', { exact: true })).toHaveValue('50');
    await expect(page.locator('[data-workload-history]')).toHaveCount(2);
  });

  test('workload check-in previous-value buttons fill only their own input without submitting', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await submitWorkloadExample(page, { maintenance: 40, meetings: 0 });
    await expect(page.locator('[data-workload-history]')).toHaveCount(1);
    await ageWorkloadCheckin();
    await page.goto('/');
    const dialog = page.locator('#workload-checkin-dialog');
    await expect(dialog).toBeVisible();
    for (const language of ['en', 'de']) {
      if (language === 'de') {
        await postForm(page, '/i18n/setlang/', { language, next: '/' });
        await page.reload();
        await expect(dialog.getByText('Vorherige 60 % übernehmen', { exact: true })).toBeVisible();
      }
      for (const width of [1024, 375, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const positions = await dialog.locator('[data-workload-previous-for]').evaluateAll(buttons => buttons.map(button => {
          const input = document.getElementById(button.dataset.workloadPreviousFor);
          const b = button.getBoundingClientRect(), i = input.getBoundingClientRect();
          return {
            beside: b.left >= i.right && Math.min(b.bottom, i.bottom) > Math.max(b.top, i.top),
            sameGroup: button.parentElement === input.parentElement,
          };
        }));
        expect(positions.every(position => position.beside && position.sameGroup)).toBe(true);
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
    }
    await postForm(page, '/i18n/setlang/', { language: 'en', next: '/' });
    await page.reload();
    await expect(dialog).toBeVisible();
    let submissions = 0;
    page.on('request', request => {
      if (request.url().endsWith('/profile/workload/save/') && request.method() === 'POST') submissions++;
    });
    const maintenance = dialog.getByLabel('Maintenance percentage', { exact: true });
    const projects = dialog.getByLabel('Project work percentage', { exact: true });
    const meetings = dialog.getByLabel('Meetings percentage', { exact: true });
    const allocation = dialog.getByLabel('Project work: API Migration percentage', { exact: true });
    const submit = dialog.getByRole('button', { name: 'Submit estimate', exact: true });
    await dialog.getByRole('button', { name: 'Use previous estimate for Maintenance: 40%', exact: true }).click();
    await expect(maintenance).toHaveValue('40');
    await expect(maintenance).toBeFocused();
    await expect(projects).toHaveValue('');
    await expect(meetings).toHaveValue('');
    await expect(allocation).toHaveValue('');
    await expect(dialog.locator('[data-workload-center-value]')).toHaveText('40%');
    await dialog.getByRole('button', { name: 'Use previous estimate for Project work: 60%', exact: true }).click();
    const zero = dialog.getByRole('button', { name: 'Use previous estimate for Meetings: 0%', exact: true });
    await zero.focus();
    await page.keyboard.press('Space');
    await expect(meetings).toHaveValue('0');
    await expect(submit).toBeDisabled(); // The project input is still empty.
    await page.setViewportSize({ width: 375, height: 812 });
    const previousProject = dialog.getByRole('button', { name: 'Use previous estimate for Project work / API Migration: 40%', exact: true });
    await previousProject.focus();
    await page.keyboard.press('Enter');
    await expect(allocation).toHaveValue('40');
    await expect(allocation).toBeFocused();
    await expect(projects).toHaveValue('60');
    await expect(dialog.locator('[data-workload-project-slice]:visible')).toHaveAttribute('data-percentage', '40');
    await expect(submit).toBeEnabled();
    expect(submissions).toBe(0);
    await submit.click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#toast-slot')).toContainText('Estimate saved.');
    expect(submissions).toBe(1);
  });

  test('workload check-in allows dismissal, manual reopening and a persistent one-week snooze', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1', { keepCheckin: true });
    await page.goto('/');
    const dialog = page.locator('#workload-checkin-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-workload-previous]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await page.goto('/people/');
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: 'Workload check-in due', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Remind me next week', exact: true }).click();
    await expect(page.locator('#toast-slot .nano-toast')).toContainText('We’ll remind you next week.');
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(dialog).toHaveCount(0);
    await ageWorkloadCheckin(31, 8);
    await page.reload();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto('/profile/workload/');
    await expect(page.locator('[data-workload-history]')).toHaveCount(0);
  });

  test('workload check-in rejects blank categories and is unavailable to exempt members', async ({ appPage: page }) => {
    expect(await postForm(page, '/profile/workload/check-in/snooze/', {})).toBe(403);
    await enableWorkload(page);
    await signInAs(page, 'member1', { keepCheckin: true });
    await page.goto('/');
    await expect(page.locator('#workload-checkin-dialog')).toBeVisible();
    const fields = await page.locator('#workload-form').evaluate(form => Object.fromEntries(new FormData(form)));
    const category = Object.keys(fields).find(key => key.startsWith('category_'));
    fields[category] = '100';
    // Bypass browser validity: omitted/empty fields must not become implicit zeros.
    await page.locator('#workload-form').evaluate((form, fields) => {
      for (const [name, value] of Object.entries(fields)) {
        const input = form.elements.namedItem(name);
        if (input) input.value = value;
      }
      form.noValidate = true;
      form.requestSubmit();
    }, fields);
    await expect(page.locator('#workload-content [role=alert]')).toContainText('Enter a percentage for every category.');
    await expect(page.locator('#workload-checkin-dialog')).toBeVisible();
    await expect(page.getByLabel('Meetings percentage', { exact: true })).toHaveValue('');
    await page.keyboard.press('Escape');
    await page.goto('/profile/workload/');
    await expect(page.locator('[data-workload-history]')).toHaveCount(0);
  });
  test('workload overview uses the shared average donut and per-user history bars', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await submitWorkloadExample(page);
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('31');
    await page.getByLabel('Project work percentage', { exact: true }).fill('59');
    await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Estimate saved');
    await signInAs(page, 'ideaeditor');
    await submitWorkloadExample(page);
    await page.getByLabel('Project work percentage', { exact: true }).fill('61');
    await page.getByLabel('Meetings percentage', { exact: true }).fill('9');
    await page.getByLabel('Project work: API Migration percentage', { exact: true }).fill('10');
    await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Estimate saved');
    await signInAs(page, 'demo');
    await page.goto('/workload/overview/');
    await expect(page.locator('#workload-coverage')).toHaveText('2 of 3 participating members reported.');
    const average = page.locator('#workload-averages');
    await expect(average.locator('[data-workload-donut]')).toBeVisible();
    await expect(average.locator('[data-workload-center-value]')).toHaveText('100%');
    await expect(average.locator('[data-workload-slice][data-percentage="30.5"]')).toHaveAttribute('stroke-dasharray', '29.7 70.3');
    await expect(average.locator('[data-workload-project-slice]')).toHaveAttribute('data-percentage', '25');
    await expect(average.locator('[data-workload-project-slice]')).toHaveAttribute('stroke-dashoffset', '-30.7');
    await expect(average).toContainText('API Migration: 25%');
    await expect(average).toContainText('Unspecified project work: 35%');
    const member = page.locator('[data-workload-user="member1"]');
    await expect(member.locator('[data-workload-donut]')).toHaveCount(0);
    await expect(member.locator('table tbody tr')).toHaveCount(1);
    await expect(member.locator('td').first().locator('time')).toBeVisible();
    await expect(member.locator('td').nth(1).getByRole('img', { name: 'Workload allocation', exact: true })).toBeVisible();
    await expect(member.locator('span[title="Maintenance: 31%"]')).toBeVisible();
    await expect(member.locator('span[title^="Project work:"]')).toHaveAttribute('title', 'Project work: 59%\nAPI Migration: 40%\nUnspecified project work: 19%');
    await expect(member).not.toContainText('API Migration:');
    await expect(page.locator('main input[type="range"], main input[type="number"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save estimate', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'DE', exact: true }).click();
    await expect(average.locator('[data-workload-slice][data-percentage="30.5"]')).toHaveAttribute('stroke-dasharray', '29.7 70.3');
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('Person', { exact: true }).selectOption({ label: 'member1' });
    await page.getByRole('button', { name: 'Filtern', exact: true }).click();
    await expect(average.locator('[data-workload-slice][data-percentage="31"]')).toBeVisible();
    await expect(average.locator('[data-workload-project-slice]')).toHaveAttribute('data-percentage', '40');
  });

  test('workload dashboard carries monthly snapshots forward without weighting frequent reporters', async ({ appPage: page }) => {
    await enableWorkload(page);
    const fixture = await seedWorkloadDashboard();
    await page.goto('/workload/overview/');
    const months = page.locator('#workload-timeline [data-workload-month]');
    await expect(months).toHaveCount(12);
    const month = offset => months.nth(11 + offset);
    await expect(month(-6)).toHaveAttribute('data-reported', '0');
    await expect(month(-6).locator('[data-category-key]')).toHaveCount(0);
    await expect(month(-5)).toHaveAttribute('data-reported', '1');
    await expect(month(-5).locator('[data-category-key]').first()).toHaveAttribute('data-percentage', '40');
    await expect(month(-4)).toHaveAttribute('data-reported', '2');
    await expect(month(-4).locator('[data-category-key]').first()).toHaveAttribute('data-percentage', '60');
    // No new reports: carry the same mix forward, rather than interpolate.
    await expect(month(-3).locator('[data-category-key]').first()).toHaveAttribute('data-percentage', '60');
    await expect(month(-2).locator('[data-category-key]').first()).toHaveAttribute('data-percentage', '70');
    await expect(month(0).locator('[data-category-key]').first()).toHaveAttribute('data-percentage', '40');
    await expect(month(0)).toHaveAttribute('data-participating', '3');
    await expect(month(-1)).toHaveAttribute('data-outdated', '1');
    await month(-4).locator('summary').click();
    await expect(month(-4).getByRole('cell', { name: '60%', exact: true })).toBeVisible();
    const highlight = page.locator('#workload-timeline').getByRole('button', { name: 'Maintenance', exact: true });
    await highlight.click();
    await expect(highlight).toHaveAttribute('aria-pressed', 'true');
    await expect(month(0).locator('[data-category-key]').nth(1)).toHaveClass(/is-muted/);
    await highlight.click();
    await expect(highlight).toHaveAttribute('aria-pressed', 'false');
    await expect(month(0).locator('[data-category-key]').nth(1)).not.toHaveClass(/is-muted/);
    // Team and person filters must affect every visualization, not only the donut.
    await page.getByLabel('Team', { exact: true }).selectOption(fixture.team);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(month(0)).toHaveAttribute('data-reported', '1');
    await expect(month(0).locator('[data-category-key]').first()).toHaveAttribute('data-percentage', '60');
    await page.getByLabel('Person', { exact: true }).selectOption(fixture.ideaeditor);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(month(0)).toHaveAttribute('data-reported', '0');
    await expect(page.locator('#workload-heatmap tbody tr[data-person]')).toHaveCount(0);
    await expect(page.locator('#workload-heatmap')).toContainText('No people match these filters.');
    await page.getByLabel('Team', { exact: true }).selectOption('');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(month(0)).toHaveAttribute('data-reported', '1');
    await expect(month(0).locator('[data-category-key]').first()).toHaveAttribute('data-percentage', '20');
    await expect(page.locator('#workload-heatmap tbody tr')).toHaveCount(1);
    await page.reload();
    await expect(page.getByLabel('Person', { exact: true })).toHaveValue(fixture.ideaeditor);
    await expect(month(0).locator('[data-category-key]').first()).toHaveAttribute('data-percentage', '20');
  });

  test('workload dashboard heatmap distinguishes missing estimates, sorts and opens personal history', async ({ appPage: page }) => {
    await enableWorkload(page);
    await seedWorkloadDashboard();
    await page.goto('/workload/overview/');
    const heatmap = page.locator('#workload-heatmap');
    await expect(heatmap.getByRole('columnheader', { name: 'Maintenance', exact: true })).toBeVisible();
    const member = heatmap.locator('[data-person="member1"]');
    await expect(member.locator('[data-percentage]').first()).toHaveAttribute('data-percentage', '60');
    await expect(member.getByRole('time')).toHaveCount(1);
    await expect(heatmap.locator('[data-person="multi1"]')).toContainText('Not reported');
    await expect(heatmap.locator('[data-person="multi1"] [data-percentage]')).toHaveCount(0);
    await expect(heatmap.locator('[data-person="demo"]')).toContainText('Exempt');
    await expect(heatmap.locator('[data-person="ideaeditor"] [data-percentage]').last()).toHaveAttribute('data-percentage', '0');
    await heatmap.getByRole('link', { name: 'Maintenance', exact: true }).click();
    await expect(heatmap.locator('tbody tr').first()).toHaveAttribute('data-person', 'member1');
    await expect(heatmap.getByRole('columnheader', { name: 'Maintenance', exact: true })).toHaveAttribute('aria-sort', 'descending');
    await member.getByRole('link', { name: 'member1', exact: true }).click();
    await expect(page.getByLabel('Person', { exact: true })).not.toHaveValue('');
    await expect(heatmap.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('#workload-person-history')).toBeVisible();
    await expect(page.locator('#workload-person-history [data-workload-history]')).toHaveCount(20);
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'DE', exact: true }).click();
    await page.locator('#workload-timeline-heading').scrollIntoViewIfNeeded();
    await expect(page.getByRole('heading', { name: 'Arbeitsverteilung im Zeitverlauf', exact: true })).toBeVisible();
    await expect(page.locator('#workload-timeline [data-workload-month]').last().locator('[data-category-key]').first()).toHaveAttribute('data-percentage', '60');
  });

  test('workload dashboard retains pre-window estimates and deleted categories without leaking other workspaces', async ({ appPage: page }) => {
    await enableWorkload(page);
    const { stdout } = await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'shell', '-c', `
from datetime import timedelta
from django.utils import timezone
from data.models import Membership, WorkloadReport, WorkloadAllocation, WorkloadCategory
membership = Membership.objects.get(user__username='member1')
workspace = membership.workspace
category = WorkloadCategory.objects.create(workspace=workspace, name='Retired category')
report = WorkloadReport.objects.create(workspace=workspace, user=membership.user, user_label='member1')
WorkloadReport.objects.filter(pk=report.pk).update(reviewed_at=timezone.now()-timedelta(days=800))
WorkloadAllocation.objects.create(report=report, category=category, category_label=category.name, percentage=100)
category.delete()
foreign = Membership.objects.get(user__username='pm2').workspace
foreign_report = WorkloadReport.objects.create(workspace=foreign, user=membership.user, user_label='member1')
WorkloadAllocation.objects.create(report=foreign_report, category_label='Secret category', percentage=100)
print(membership.user_id)
`], { cwd: path.resolve(__dirname, '../..'), env: djangoEnv() });
    await page.goto('/workload/overview/');
    const months = page.locator('#workload-timeline [data-workload-month]');
    await expect(months.first()).toHaveAttribute('data-reported', '1');
    await expect(months.first()).toHaveAttribute('data-outdated', '1');
    await expect(months.first().locator('[data-category-key]')).toHaveAttribute('data-percentage', '100');
    await expect(page.locator('#workload-timeline')).toContainText('Retired category');
    await expect(page.locator('main')).not.toContainText('Secret category');
    const member = page.locator('#workload-heatmap [data-person="member1"]');
    await expect(member.locator('[data-percentage]')).toHaveCount(1);
    await expect(member.locator('[data-percentage]')).toHaveAttribute('data-percentage', '100');
    await expect(member.getByLabel('Not recorded', { exact: true })).toHaveCount(3);
    await page.getByLabel('Person', { exact: true }).selectOption(stdout.trim().split('\n').at(-1));
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(page.locator('#workload-person-history [data-workload-history]')).toHaveCount(1);
    await signInAs(page, 'member1');
    expect((await page.goto('/workload/overview/')).status()).toBe(403);
  });

  test('workload overview keeps small averaged project shares visible in the shared donut', async ({ appPage: page }) => {
    await enableWorkload(page);
    for (const username of ['member1', 'ideaeditor', 'multi1']) {
      await signInAs(page, username);
      await page.goto('/profile/workload/');
      await page.getByLabel('Project work percentage', { exact: true }).fill('100');
      if (username === 'member1') {
        await page.getByText('Optional project breakdown', { exact: true }).click();
        await page.locator('.workload-projects').getByRole('button', { name: 'Add API Migration', exact: true }).click();
        await page.getByLabel('Project work: API Migration percentage', { exact: true }).fill('1');
      }
      await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
      await expect(page.locator('#workload-status')).toContainText('Estimate saved');
    }
    await signInAs(page, 'demo');
    await page.goto('/workload/overview/');
    const project = page.locator('#workload-averages [data-workload-project-slice]');
    await expect(project).toHaveAttribute('data-percentage', '0.333333');
    expect(Number((await project.getAttribute('stroke-dasharray')).split(' ')[0])).toBeGreaterThan(0);
    await expect(page.locator('#workload-averages [data-workload-center-value]')).toHaveText('100%');
  });

  test('workload overview shared donut represents an empty respondent set without invented allocations', async ({ appPage: page }) => {
    await enableWorkload(page);
    await page.goto('/workload/overview/');
    const average = page.locator('#workload-averages');
    await expect(average.locator('[data-workload-donut]')).toBeVisible();
    await expect(average.locator('[data-workload-center-value]')).toHaveText('0%');
    await expect(average.locator('[data-workload-remainder]')).toHaveAttribute('data-percentage', '100');
    await expect(average).toContainText('No reports from participating members.');
    await expect(page.locator('[data-workload-user="member1"]')).toContainText('Not reported');
    await expect(page.locator('[data-workload-user="demo"]')).toContainText('Exempt');
    await expect(page.locator('[data-workload-project-slice]')).toHaveCount(0);
  });

  test('German workload guidance and validation use informal address', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/profile/workload/');
    await page.getByRole('button', { name: 'DE', exact: true }).click();
    await expect(page.locator('#workload-content')).toContainText('Anteile deiner Arbeit, keine Stunden.');
    await expect(page.getByRole('heading', { name: 'Deine aktiven Projekte', exact: true })).toBeVisible();
    await page.getByText('Optionale Aufteilung nach Projekten', { exact: true }).click();
    await expect(page.locator('.workload-project-body')).toContainText('Anteile deiner gesamten Arbeit in Prozent');
    await expect(page.getByLabel('Alle Projekte anzeigen', { exact: true })).not.toBeChecked();
    await expect(page.locator('.workload-project-body')).toContainText('Lass den Rest ohne Zuordnung oder wähle unten ein Projekt.');
    await expect(page.locator('body')).not.toContainText(/\b(?:Sie|Ihnen|Ihr(?:e|en|em|er|es)?)\b/);

    const maintenance = page.getByLabel('Maintenance – Prozentanteil', { exact: true });
    await maintenance.fill('-1');
    await expect(page.locator('#workload-feedback')).toHaveText('Gib ganze Prozentwerte zwischen 0 und 100 ein.');
    await maintenance.fill('100');
    await page.getByLabel('Meetings – Prozentanteil', { exact: true }).fill('10');
    await expect(page.locator('#workload-feedback')).toHaveText('10% zu viel — reduziere einen Anteil');
    await expect(page.getByRole('button', { name: 'Schätzung speichern', exact: true })).toBeDisabled();
  });

  for (const width of [320, 520, 1024]) {
    test(`workload percentage inputs remain readable at ${width}px`, async ({ appPage: page }, testInfo) => {
      await enableWorkload(page);
      await signInAs(page, 'member1');
      await page.goto('/profile/workload/');
      await page.getByRole('button', { name: 'DE', exact: true }).click();
      await expect(page.getByLabel('Maintenance – Prozentanteil', { exact: true })).toBeVisible();
      await page.setViewportSize({ width, height: 900 });
      await page.getByLabel('Project work – Prozentanteil', { exact: true }).fill('57');
      await page.getByText('Optionale Aufteilung nach Projekten', { exact: true }).click();
      await page.locator('.workload-projects').getByRole('button', { name: 'API Migration hinzufügen', exact: true }).click();
      const category = page.getByLabel('Maintenance – Prozentanteil', { exact: true });
      const project = page.getByLabel('Project work: API Migration – Prozentanteil', { exact: true });
      for (const input of [category, project]) {
        for (const value of ['0', '43', '100']) {
          await input.fill(value);
          await input.hover();
          await expect(input).toBeFocused();
          await expect(input).toHaveValue(value);
          await expect(input).toHaveCSS('text-align', 'right');
          // A fixed, nonshrinking control must fit three digits plus padding;
          // native steppers cannot eat the text area at compact widths.
          await expect(input).toHaveCSS('flex-shrink', '0');
          const dimensions = await input.evaluate(element => {
            const style = getComputedStyle(element);
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = `${style.fontSize} ${style.fontFamily}`;
            const box = element.getBoundingClientRect();
            const suffix = element.parentElement.querySelector('span').getBoundingClientRect();
            return {
              width: box.width,
              textSpace: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
              digits: canvas.measureText('100').width,
              right: box.right,
              suffixLeft: suffix.left,
            };
          });
          expect(dimensions.width).toBeGreaterThanOrEqual(76);
          expect(dimensions.textSpace).toBeGreaterThanOrEqual(dimensions.digits + 8);
          expect(dimensions.suffixLeft).toBeGreaterThan(dimensions.right);
        }
        await input.fill('43');
      }
      const projectName = await project.evaluate(element => {
        const label = element.closest('[data-workload-project-row]').querySelector('label');
        const style = getComputedStyle(label);
        const canvas = document.createElement('canvas').getContext('2d');
        canvas.font = `${style.fontSize} ${style.fontFamily}`;
        return { width: label.getBoundingClientRect().width, needed: canvas.measureText(label.textContent.trim()).width + 18 };
      });
      expect(projectName.width).toBeGreaterThanOrEqual(projectName.needed);
      await expect(category).toHaveCSS('appearance', 'textfield');
      await expect(project).toHaveCSS('appearance', 'textfield');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('workload-compact-inputs.png'), fullPage: true });
      await category.scrollIntoViewIfNeeded();
      await category.focus();
      await category.press('ArrowUp');
      await expect(category).toHaveValue('44');
      await category.press('ArrowDown');
      await expect(category).toHaveValue('43');
    });
  }

  test('workload donut visualizes project shares without double counting categories', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/profile/workload/');
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('30');
    await page.getByLabel('Project work percentage', { exact: true }).fill('60');
    await page.getByLabel('Meetings percentage', { exact: true }).fill('10');
    await page.getByText('Optional project breakdown', { exact: true }).click();
    const body = page.locator('.workload-project-body');
    await body.getByRole('button', { name: 'Add API Migration', exact: true }).click();
    const api = page.getByLabel('Project work: API Migration percentage', { exact: true });
    await api.fill('40');
    const donut = page.locator('[data-workload-donut]');
    const arc = donut.getByRole('button', { name: 'Project work: API Migration: 40%', exact: true });
    await expect(arc).toBeVisible();
    await expect(arc).toHaveAttribute('data-percentage', '40');
    await expect(arc).toHaveAttribute('stroke-dashoffset', '-30.2');
    await expect(page.locator('[data-workload-project-ring-remainder]')).toHaveAttribute('data-percentage', '20');
    const legend = page.locator('[data-workload-project-legend]');
    await expect(legend).toContainText('API Migration');
    await expect(legend).toContainText('40%');
    await expect(legend).toContainText('Unspecified: 20%');
    await page.getByText('Optional project breakdown', { exact: true }).click();
    await expect(api).toBeHidden();
    await expect(arc).toBeVisible();
    await arc.focus();
    await arc.press('Enter');
    await expect(api).toBeFocused();
    await expect(arc).toHaveClass(/is-highlighted/);
    await body.getByLabel('Show all projects', { exact: true }).check();
    await body.getByRole('button', { name: 'Add Onboarding revamp', exact: true }).click();
    await page.getByLabel('Project work: Onboarding revamp percentage', { exact: true }).fill('15');
    await expect(donut.getByRole('button', { name: 'Project work: Onboarding revamp: 15%', exact: true })).toBeVisible();
    await expect(page.locator('[data-workload-project-ring-remainder]')).toHaveAttribute('data-percentage', '5');
    await expect(page.locator('[data-workload-center-value]')).toHaveText('100%');
    await api.fill('65');
    await expect(page.locator('[data-workload-project-slice]:visible')).toHaveCount(0);
    await api.fill('40');
    await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Estimate saved');
    await expect(arc).toBeVisible();
    await page.reload();
    await expect(arc).toBeVisible();
    await body.getByRole('button', { name: 'Remove API Migration', exact: true }).click();
    await expect(arc).toBeHidden();
    await expect(legend.locator('[data-workload-project-legend-item]:visible')).toHaveCount(1);
    await expect(legend.locator('[data-workload-project-legend-item]:visible')).toContainText('Onboarding revamp');
    await expect(page.locator('[data-workload-project-ring-remainder]')).toHaveAttribute('data-percentage', '45');
  });

  for (const [layout, viewport] of Object.entries({
    desktop: { width: 1280, height: 1000 },
    mobile: { width: 390, height: 844 },
  })) {
    test(`workload project chips add and remove only selected allocation rows on ${layout}`, async ({ appPage: page }) => {
      await enableWorkload(page);
      await signInAs(page, 'member1');
      await page.setViewportSize(viewport);
      await page.goto('/profile/workload/');
      await page.getByLabel('Maintenance percentage', { exact: true }).fill('30');
      await page.getByLabel('Project work percentage', { exact: true }).fill('60');
      await page.getByLabel('Meetings percentage', { exact: true }).fill('10');
      await page.getByText('Optional project breakdown', { exact: true }).click();
      const body = page.locator('.workload-project-body');
      const rows = body.locator('[data-workload-project-row]:visible');
      const api = page.getByLabel('Project work: API Migration percentage', { exact: true });
      const onboarding = page.getByLabel('Project work: Onboarding revamp percentage', { exact: true });
      const addApi = body.getByRole('button', { name: 'Add API Migration', exact: true });
      await expect(rows).toHaveCount(0);
      await expect(body.getByText('Percentages of your total workload', { exact: true })).toBeVisible();
      await expect(body.locator('[data-workload-project-add]:visible')).toHaveCount(2);
      await body.getByLabel('Show all projects', { exact: true }).check();
      await expect(body.locator('[data-workload-project-add]:visible')).toHaveCount(3);
      await addApi.click();
      await expect(rows).toHaveCount(1);
      await expect(api).toBeFocused();
      await expect(api).toHaveValue('0');
      await expect(addApi).toBeHidden();
      await api.fill('40');
      await body.getByRole('button', { name: 'Add Onboarding revamp', exact: true }).click();
      await onboarding.fill('15');
      await expect(page.locator('[data-workload-project-summary]')).toHaveText('55% assigned · 5% unspecified');
      await body.getByRole('button', { name: 'Remove API Migration', exact: true }).click();
      await expect(rows).toHaveCount(1);
      await expect(api).toBeHidden();
      await expect(api).toBeDisabled();
      await expect(addApi).toBeFocused();
      await expect(onboarding).toHaveValue('15');
      await expect(page.locator('[data-workload-project-summary]')).toHaveText('15% assigned · 45% unspecified');
      await addApi.press('Enter');
      await expect(api).toBeFocused();
      await expect(api).toHaveValue('0');
      await api.fill('20');
      await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
      await expect(page.locator('#workload-status')).toContainText('Estimate saved');
      await expect(rows).toHaveCount(2);
      await expect(body.locator('[data-workload-project-add]:visible')).toHaveCount(1);
      await page.reload();
      await expect(rows).toHaveCount(2);
      await expect(api).toHaveValue('20');
      await expect(onboarding).toHaveValue('15');
      await body.getByRole('button', { name: 'Remove API Migration', exact: true }).click();
      await body.getByRole('button', { name: 'Remove Onboarding revamp', exact: true }).click();
      await expect(page.locator('[data-workload-project-summary]')).toHaveText('0% assigned · 60% unspecified');
      await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
      await expect(page.locator('#workload-status')).toContainText('Estimate saved');
      await page.reload();
      await page.getByText('Optional project breakdown', { exact: true }).click();
      await expect(rows).toHaveCount(0);
      await expect(body.locator('[data-workload-project-add]:visible')).toHaveCount(2);
      await expect(page.locator('[data-workload-history]').first().locator('span[title^="Project work:"]')).not.toHaveAttribute('title', /API Migration:/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  for (const [layout, viewport] of Object.entries({
    desktop: { width: 1280, height: 1000 },
    mobile: { width: 390, height: 844 },
  })) {
    test(`workload sliders keep dragging and focus stable across preview changes on ${layout}`, async ({ appPage: page }) => {
      await enableWorkload(page);
      await signInAs(page, 'member1');
      await page.setViewportSize(viewport);
      await page.goto('/profile/workload/');
      await page.getByLabel('Maintenance percentage', { exact: true }).fill('30');
      await page.getByLabel('Project work percentage', { exact: true }).fill('60');
      await page.getByLabel('Meetings percentage', { exact: true }).fill('10');
      await page.getByText('Optional project breakdown', { exact: true }).click();
      await page.locator('.workload-projects').getByRole('button', { name: 'Add API Migration', exact: true }).click();
      await page.getByLabel('Project work: API Migration percentage', { exact: true }).fill('40');
      await page.getByText('Optional project breakdown', { exact: true }).click();
      const slider = page.getByRole('slider', { name: 'Meetings allocation', exact: true });
      await slider.scrollIntoViewIfNeeded();
      const box = await slider.boundingBox();
      const x = percentage => box.x + 9 + (box.width - 18) * percentage / 100;
      const y = box.y + box.height / 2;
      let submissions = 0;
      page.on('request', request => { if (request.url().endsWith('/profile/workload/save/')) submissions++; });
      await slider.evaluate(element => { window.draggedWorkloadSlider = element; });
      await page.mouse.move(x(10), y);
      await page.mouse.down();
      for (const value of [5, 20, 0, 10]) {
        await page.mouse.move(x(value), y, { steps: 5 });
        await expect(slider).toBeFocused();
        await expect(slider).toHaveValue(String(value));
        await expect(page.getByLabel('Meetings percentage', { exact: true })).toHaveValue(String(value));
        expect((await slider.boundingBox()).y).toBe(box.y);
        expect(await slider.evaluate(element => element === window.draggedWorkloadSlider)).toBe(true);
      }
      await page.mouse.up();
      expect(submissions).toBe(0);
      await expect(slider).toHaveAttribute('id', /workload-slider-category_\d+/);
    });
  }

  test('workload project rings align with each project-enabled category', async ({ appPage: page }) => {
    await enableWorkload(page);
    const maintenanceSetting = page.locator('[data-workload-category]', { has: page.locator('input[value="Maintenance"]') });
    await maintenanceSetting.getByLabel('Allow project breakdown', { exact: true }).check();
    await expect(maintenanceSetting).toHaveAttribute('data-supports-projects', 'true');
    await signInAs(page, 'member1');
    await page.goto('/profile/workload/');
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('40');
    await page.getByLabel('Project work percentage', { exact: true }).fill('50');
    await page.getByLabel('Meetings percentage', { exact: true }).fill('10');
    for (const [category, project, amount] of [
      ['Maintenance', 'API Migration', '20'],
      ['Project work', 'Infra hardening', '35'],
    ]) {
      const row = page.locator('[data-workload-row]').filter({ has: page.getByLabel(`${category} percentage`, { exact: true }) });
      await row.getByText('Optional project breakdown', { exact: true }).click();
      await row.getByRole('button', { name: `Add ${project}`, exact: true }).click();
      await page.getByLabel(`${category}: ${project} percentage`, { exact: true }).fill(amount);
    }
    const donut = page.locator('[data-workload-donut]');
    await expect(donut.getByRole('button', { name: 'Maintenance: API Migration: 20%', exact: true })).toHaveAttribute('stroke-dashoffset', '-0.2');
    const projectWorkArc = donut.getByRole('button', { name: 'Project work: Infra hardening: 35%', exact: true });
    await expect(projectWorkArc).toHaveAttribute('stroke-dashoffset', '-40.2');
    await expect(page.locator('[data-workload-project-ring-remainder]')).toHaveCount(2);
    await expect(page.locator('[data-workload-project-ring-remainder]').first()).toHaveAttribute('data-percentage', '20');
    await expect(page.locator('[data-workload-project-ring-remainder]').last()).toHaveAttribute('data-percentage', '15');
    await expect(page.locator('[data-workload-center-value]')).toHaveText('100%');
    await page.getByLabel('Maintenance: API Migration percentage', { exact: true }).fill('45');
    await expect(page.locator('[data-workload-project-slice]:visible')).toHaveCount(1);
    await expect(projectWorkArc).toBeVisible();
  });

  test('workload project chips preserve zero-valued selections after server validation', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/profile/workload/');
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('30');
    await page.getByLabel('Project work percentage', { exact: true }).fill('60');
    await page.getByLabel('Meetings percentage', { exact: true }).fill('10');
    await page.getByText('Optional project breakdown', { exact: true }).click();
    const body = page.locator('.workload-project-body');
    await body.getByRole('button', { name: 'Add API Migration', exact: true }).click();
    await body.getByLabel('Show all projects', { exact: true }).check();
    await body.getByRole('button', { name: 'Add Onboarding revamp', exact: true }).click();
    const onboarding = page.getByLabel('Project work: Onboarding revamp percentage', { exact: true });
    await onboarding.fill('65');
    // Bypass the disabled Save button to exercise a genuine server error patch.
    await page.locator('#workload-form').evaluate(form => form.requestSubmit());
    await expect(page.getByRole('alert')).toContainText('Project allocations cannot exceed');
    await expect(body.locator('[data-workload-project-row]:visible')).toHaveCount(2);
    await expect(page.getByLabel('Project work: API Migration percentage', { exact: true })).toHaveValue('0');
    await expect(onboarding).toHaveValue('65');
    await expect(body.getByRole('button', { name: 'Add API Migration', exact: true })).toBeHidden();
    await expect(body.getByRole('button', { name: 'Add Infra hardening', exact: true })).toBeVisible();
    await onboarding.fill('15');
    await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Estimate saved');
    await expect(body.locator('[data-workload-project-row]:visible')).toHaveCount(1);
    await expect(body.getByRole('button', { name: 'Add API Migration', exact: true })).toBeVisible();
  });

  test('workload SSE saves preserve a focused keyed slider', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/profile/workload/');
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('30');
    await page.getByLabel('Project work percentage', { exact: true }).fill('60');
    await page.getByLabel('Meetings percentage', { exact: true }).fill('10');
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let received;
    const responseReady = new Promise(resolve => { received = resolve; });
    await page.route('**/profile/workload/save/', async route => {
      const response = await route.fetch();
      received();
      await pending;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
    await responseReady;
    const slider = page.getByRole('slider', { name: 'Project work allocation', exact: true });
    await slider.focus();
    await slider.evaluate(element => { window.focusedWorkloadSlider = element; });
    release();
    await expect(page.locator('#workload-status')).toContainText('Estimate saved');
    await expect(slider).toBeFocused();
    expect(await slider.evaluate(element => element === window.focusedWorkloadSlider)).toBe(true);
    await expect(slider).toHaveAttribute('id', /workload-slider-category_\d+/);
    await slider.press('ArrowRight');
    await expect(page.getByLabel('Project work percentage', { exact: true })).toHaveValue('61');
    const ids = await page.locator('#workload-content [id]').evaluateAll(elements => elements.map(element => element.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('workload donut center always shows summed category percentages', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/profile/workload/');
    const center = page.locator('[data-workload-center-value]');
    const label = page.locator('[data-workload-center-label]');
    await expect(center).toHaveText('0%');
    await expect(label).toHaveText('allocated');
    for (const [maintenance, projects, meetings, sum] of [
      ['25', '0', '0', '25%'],
      ['25', '60', '0', '85%'],
      ['25', '60', '15', '100%'],
      ['25', '60', '25', '110%'],
      ['101', '0', '0', '101%'],
      ['50.5', '0', '0', '50.5%'],
      ['-1', '0', '0', '-1%'],
      ['', '0', '0', '0%'],
    ]) {
      await page.getByLabel('Maintenance percentage', { exact: true }).fill(maintenance);
      await page.getByLabel('Project work percentage', { exact: true }).fill(projects);
      await page.getByLabel('Meetings percentage', { exact: true }).fill(meetings);
      await expect(center).toHaveText(sum);
      await expect(label).toHaveText('allocated');
    }
    await page.getByLabel('Project work percentage', { exact: true }).fill('60');
    await page.getByText('Optional project breakdown', { exact: true }).click();
    await page.locator('.workload-projects').getByRole('button', { name: 'Add API Migration', exact: true }).click();
    await page.getByLabel('Project work: API Migration percentage', { exact: true }).fill('40');
    await expect(center).toHaveText('60%');
  });

  test('workload donut previews sliders, remaining allocation and explicit saves', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/profile/workload/');
    const save = page.getByRole('button', { name: 'Save estimate', exact: true });
    const maintenance = page.getByLabel('Maintenance percentage', { exact: true });
    const slider = page.getByRole('slider', { name: 'Maintenance allocation', exact: true });
    const donut = page.locator('[data-workload-donut]');
    await expect(donut).toBeVisible();
    await expect(page.locator('[data-workload-feedback]')).toHaveText('100% left to allocate');
    await expect(save).toBeDisabled();
    await slider.focus();
    await slider.press('ArrowRight');
    await expect(maintenance).toHaveValue('1');
    await maintenance.fill('25');
    await expect(slider).toHaveValue('25');
    await page.getByLabel('Project work percentage', { exact: true }).fill('60');
    await expect(page.locator('[data-workload-feedback]')).toHaveText('15% left to allocate');
    await expect(page.locator('[data-workload-remainder]')).toHaveAttribute('data-percentage', '15');
    await page.locator('[data-workload-row]').filter({ has: page.getByLabel('Meetings percentage', { exact: true }) }).getByRole('button', { name: 'Fill remaining 15%', exact: true }).click();
    await expect(page.getByLabel('Meetings percentage', { exact: true })).toHaveValue('15');
    await expect(page.locator('[data-workload-feedback]')).toHaveText('100% allocated');
    await expect(save).toBeEnabled();
    const slice = donut.getByRole('button', { name: 'Maintenance: 25%', exact: true });
    await slice.focus();
    await slice.press('Enter');
    await expect(maintenance).toBeFocused();
    await expect(slice).toHaveClass(/is-highlighted/);
    await page.getByLabel('Meetings percentage', { exact: true }).fill('25');
    await expect(page.locator('[data-workload-feedback]')).toHaveText('10% over — reduce an allocation');
    await expect(save).toBeDisabled();
    await expect(maintenance).toHaveValue('25');
    await expect(page.getByLabel('Project work percentage', { exact: true })).toHaveValue('60');
    await expect(page.locator('[data-workload-history]')).toHaveCount(0);
    await page.getByLabel('Meetings percentage', { exact: true }).fill('15');
    await save.click();
    await expect(page.locator('#workload-status')).toContainText('Estimate saved');
    await expect(page.locator('[data-workload-history]')).toHaveCount(1);
    await expect(page.locator('[data-workload-feedback]')).toHaveText('100% allocated');
    await expect(slider).toHaveValue('25');
    await slider.focus();
    await slider.press('ArrowLeft');
    await expect(maintenance).toHaveValue('24');
    await expect(page.locator('[data-workload-feedback]')).toHaveText('1% left to allocate');
    await page.getByRole('button', { name: 'Still accurate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Review date refreshed');
    await expect(maintenance).toHaveValue('25');
    await page.reload();
    await expect(donut.getByRole('button', { name: 'Maintenance: 25%', exact: true })).toBeVisible();
  });

  test('workload preview explains invalid numbers and translates dynamic labels', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/profile/workload/');
    const maintenance = page.getByLabel('Maintenance percentage', { exact: true });
    await maintenance.fill('100');
    await expect(page.getByRole('button', { name: 'Save estimate', exact: true })).toBeEnabled();
    for (const value of ['-1', '101', '50.5', '']) {
      await maintenance.fill(value);
      await expect(page.locator('[data-workload-feedback]')).toHaveText('Enter whole percentages between 0 and 100.');
      await expect(maintenance).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('button', { name: 'Save estimate', exact: true })).toBeDisabled();
    }
    await page.getByRole('button', { name: 'DE', exact: true }).click();
    await expect(page.locator('[data-workload-feedback]')).toHaveText('100% noch zu verteilen');
    await page.getByLabel('Maintenance – Prozentanteil', { exact: true }).fill('80');
    await expect(page.getByRole('slider', { name: 'Maintenance – Anteil', exact: true })).toHaveValue('80');
    await expect(page.locator('[data-workload-feedback]')).toHaveText('20% noch zu verteilen');
    await expect(page.getByRole('button', { name: 'Verbleibende 20% zuweisen', exact: true })).toHaveCount(3);
    await page.getByText('Optionale Aufteilung nach Projekten', { exact: true }).click();
    await expect(page.locator('[data-workload-project-summary]')).toHaveText('0% zugewiesen · 0% ohne Zuordnung');
    const body = page.locator('.workload-project-body');
    await body.getByRole('button', { name: 'API Migration hinzufügen', exact: true }).click();
    const api = page.getByLabel('Project work: API Migration – Prozentanteil', { exact: true });
    await expect(api).toBeFocused();
    await page.getByLabel('Project work – Prozentanteil', { exact: true }).fill('20');
    await api.fill('10');
    await expect(page.locator('[data-workload-project-legend]')).toContainText('Projekte · äußerer Ring');
    await expect(page.locator('[data-workload-project-legend]')).toContainText('Ohne Zuordnung: 10%');
    await body.getByRole('button', { name: 'API Migration entfernen', exact: true }).click();
    await expect(body.getByRole('button', { name: 'API Migration hinzufügen', exact: true })).toBeFocused();
  });

  test('workload project breakdown previews overall shares and blocks invalid drafts', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/profile/workload/');
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('30');
    await page.getByLabel('Project work percentage', { exact: true }).fill('60');
    await page.getByLabel('Meetings percentage', { exact: true }).fill('10');
    await page.locator('#workload-guidance').getByRole('button', { name: 'API Migration', exact: true }).click();
    const project = page.getByLabel('Project work: API Migration percentage', { exact: true });
    await expect(project).toBeFocused();
    await project.fill('40');
    await expect(page.locator('[data-workload-project-summary]')).toHaveText('40% assigned · 20% unspecified');
    await expect(page.locator('[data-workload-project-segment]').first()).toHaveAttribute('data-percentage', '40');
    await project.fill('65');
    await expect(page.locator('[data-workload-project-error]')).toContainText('Project allocations cannot exceed their category percentage.');
    await expect(page.getByRole('button', { name: 'Save estimate', exact: true })).toBeDisabled();
    await project.fill('40');
    await page.getByLabel('Project work percentage', { exact: true }).fill('35');
    await expect(project).toHaveValue('40');
    await expect(page.locator('[data-workload-project-error]')).toBeVisible();
    await page.getByLabel('Project work percentage', { exact: true }).fill('60');
    await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Estimate saved');
    await expect(page.locator('[data-workload-project-summary]')).toHaveText('40% assigned · 20% unspecified');
    await expect(project).toBeVisible();
  });

  test('personal workload is a profile sub-page rather than a sidebar entry', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    const menu = page.locator('.drawer-side .menu');
    await expect(menu.getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    const profile = menu.getByRole('link', { name: 'My Profile', exact: true });
    await profile.click();
    await page.waitForURL('/profile/');
    const workload = page.locator('main').getByRole('link', { name: 'My workload', exact: true });
    await expect(workload).toHaveAttribute('href', '/profile/workload/');
    await workload.click();
    await page.waitForURL('/profile/workload/');
    await expect(profile).toHaveClass(/menu-active/);
    await expect(profile).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'My workload', exact: true })).toBeVisible();
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('30');
    await page.getByLabel('Project work percentage', { exact: true }).fill('60');
    await page.getByLabel('Meetings percentage', { exact: true }).fill('10');
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/profile/workload/save/') && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Save estimate', exact: true }).click(),
    ]);
    await expect(page.locator('#workload-status')).toContainText('Estimate saved.');
    await page.locator('main').getByRole('link', { name: 'My profile', exact: true }).click();
    await page.waitForURL('/profile/');
    await page.getByRole('button', { name: 'DE', exact: true }).click();
    await expect(page.locator('main').getByRole('link', { name: 'Meine Arbeitsverteilung', exact: true })).toBeVisible();
    await page.locator('main').getByRole('link', { name: 'Meine Arbeitsverteilung', exact: true }).click();
    await page.waitForURL('/profile/workload/');
    await expect(menu.getByRole('link', { name: 'Meine Arbeitsverteilung', exact: true })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: 'Mein Profil', exact: true })).toHaveClass(/menu-active/);
    await expect(page.getByRole('heading', { name: 'Meine Arbeitsverteilung', exact: true })).toBeVisible();
    await expect(page.locator('main').getByRole('link', { name: 'Mein Profil', exact: true })).toHaveAttribute('href', '/profile/');
  });

  test('profile workload sub-page respects participation and redirects old personal links', async ({ appPage: page }) => {
    await enableWorkload(page);
    await page.goto('/profile/');
    await expect(page.locator('main').getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    expect((await page.goto('/profile/workload/')).status()).toBe(403);
    await page.goto('/');
    await signInAs(page, 'member1');
    await page.goto('/workload/');
    await expect(page).toHaveURL(/\/profile\/workload\/$/);
    await page.goto('/');
    await signInAs(page, 'demo');
    await page.goto('/workspaces/workload/');
    const member = page.locator('[data-workload-member="member1"]');
    await member.getByRole('radio', { name: 'Exempt', exact: true }).check();
    await expect(member).toHaveAttribute('data-participation', 'exempt');
    await signInAs(page, 'member1');
    await page.goto('/profile/');
    await expect(page.locator('main').getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    expect(await postForm(page, '/profile/workload/save/', {})).toBe(403);
    expect((await page.goto('/profile/workload/')).status()).toBe(403);
  });

  test('disabling workload reminders hides cadence immediately and restores its saved value when enabled', async ({ appPage: page }) => {
    await enableWorkload(page);
    const automatic = page.getByRole('switch', { name: 'Show automatic workload check-in dialogs', exact: true });
    const cadence = page.getByLabel('Ask again after (days)', { exact: true });
    await cadence.fill('9');
    await cadence.press('Tab');
    await expect(page.locator('#workload-checkin-cadence')).toHaveAttribute('data-interval-days', '9');
    await automatic.uncheck();
    await expect(page.locator('[data-workload-setting="workload_checkin_enabled"]')).toHaveAttribute('data-enabled', 'false');
    await expect(cadence).toHaveCount(0);
    await page.reload();
    await expect(cadence).toHaveCount(0);
    await automatic.check();
    await expect(cadence).toHaveValue('9');
    await expect(page.getByRole('switch', { name: 'Include members by default', exact: true })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Include PMs by default', exact: true })).not.toBeChecked();
  });

  test('disabling workload check-ins without a modal does not patch a missing target', async ({ appPage: page }) => {
    const errors = [];
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.message));
    await enableWorkload(page);
    await expect(page.locator('#workload-checkin-dialog')).toHaveCount(0); // PM is exempt.
    await page.getByRole('switch', { name: 'Show automatic workload check-in dialogs', exact: true }).uncheck();
    await expect(page.locator('[data-workload-setting="workload_checkin_enabled"]')).toHaveAttribute('data-enabled', 'false');
    await page.getByRole('switch', { name: 'Enable workload reporting', exact: true }).uncheck();
    await expect(page.locator('[data-workload-setting="workload_enabled"]')).toHaveAttribute('data-enabled', 'false');
    await page.reload();
    expect(errors.filter(error => error.includes('PatchElementsNoTargetsFound'))).toEqual([]);
  });

  test('workspace workload check-in cadence uses the configured number of days and validates changes', async ({ appPage: page }) => {
    await enableWorkload(page);
    const cadence = page.getByLabel('Ask again after (days)', { exact: true });
    await expect(cadence).toHaveValue('7');
    await signInAs(page, 'member1');
    await submitWorkloadExample(page);
    await ageWorkloadCheckin(6);
    await page.goto('/');
    await expect(page.locator('#workload-checkin-dialog')).toHaveCount(0);
    expect(await postForm(page, '/workspaces/workload/settings/workload_checkin_interval_days/', { workload_checkin_interval_days: '7' })).toBe(403);
    await signInAs(page, 'demo');
    await page.goto('/workspaces/settings/workload/');
    await cadence.fill('1');
    await cadence.press('Tab');
    const committed = page.locator('#workload-checkin-cadence');
    await expect(committed).toHaveAttribute('data-interval-days', '1');
    for (const value of ['', '0', '-1', '366', '1.5', 'abc']) {
      expect(await postForm(page, '/workspaces/workload/settings/workload_checkin_interval_days/', { workload_checkin_interval_days: value })).toBe(400);
    }
    await page.reload();
    await expect(cadence).toHaveValue('1');
    await signInAs(page, 'member1', { keepCheckin: true });
    await expect(page.locator('#workload-checkin-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await signInAs(page, 'demo');
    await page.goto('/workspaces/settings/workload/');
    await cadence.fill('14');
    await cadence.press('Tab');
    await expect(committed).toHaveAttribute('data-interval-days', '14');
    await signInAs(page, 'member1', { keepCheckin: true });
    await expect(page.locator('#workload-checkin-dialog')).toHaveCount(0);
    await page.goto('/profile/workload/');
    await expect(page.getByLabel('Maintenance percentage', { exact: true })).toHaveValue('30');
    await expect(page.locator('[data-workload-history]')).toHaveCount(1);
  });

  test('workspace settings control automatic workload check-in dialogs without disabling manual estimates', async ({ appPage: page }) => {
    await enableWorkload(page);
    const automatic = page.getByRole('switch', { name: 'Show automatic workload check-in dialogs', exact: true });
    await expect(automatic).toBeChecked();
    const cadence = page.getByLabel('Ask again after (days)', { exact: true });
    await cadence.fill('14');
    await cadence.press('Tab');
    await expect(page.locator('#workload-checkin-cadence')).toHaveAttribute('data-interval-days', '14');
    const originalWorkspace = await page.locator('#workspace-menu form', { has: page.locator('.workspace-item.active') }).getAttribute('action');
    await automatic.uncheck();
    await expect(page.locator('[data-workload-setting="workload_checkin_enabled"]')).toHaveAttribute('data-enabled', 'false');
    await page.reload();
    await expect(automatic).not.toBeChecked();
    expect(await postForm(page, '/workspaces/workload/settings/workload_checkin_enabled/', { workload_checkin_enabled: 'invalid' })).toBe(400);
    // The preference belongs to this workspace, not the user's account.
    expect(await postForm(page, '/workspaces/', { name: 'Another check-in policy' })).toBe(200);
    await enableWorkload(page);
    await expect(automatic).toBeChecked();
    await expect(cadence).toHaveValue('7');
    expect(await postForm(page, originalWorkspace, {})).toBe(200);
    await page.goto('/workspaces/settings/workload/');
    await expect(automatic).not.toBeChecked();
    await expect(cadence).toHaveCount(0);
    await signInAs(page, 'member1', { keepCheckin: true });
    await expect(page.locator('#workload-checkin-dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Workload check-in due', exact: true })).toHaveCount(0);
    expect(await postForm(page, '/workspaces/workload/settings/workload_checkin_enabled/', { workload_checkin_enabled: 'on' })).toBe(403);
    await submitWorkloadExample(page);
    await ageWorkloadCheckin();
    await page.goto('/');
    await expect(page.locator('#workload-checkin-dialog')).toHaveCount(0);
    await signInAs(page, 'demo');
    expect(await postForm(page, originalWorkspace, {})).toBe(200);
    await page.goto('/workspaces/settings/workload/');
    await automatic.check();
    await expect(page.locator('[data-workload-setting="workload_checkin_enabled"]')).toHaveAttribute('data-enabled', 'true');
    await expect(cadence).toHaveValue('14');
    await signInAs(page, 'member1', { keepCheckin: true });
    await expect(page.locator('#workload-checkin-dialog')).toBeVisible();
    await expect(page.locator('[data-workload-percentage]').first()).toHaveValue('');
    await expect(page.locator('[data-workload-previous]').first()).toHaveText('Use previous 30%');
  });

  test('workload settings switches save independently and refresh categories and navigation without reload', async ({ appPage: page }) => {
    await page.goto('/workspaces/workload/');
    await expect(page).toHaveURL(/\/workspaces\/settings\/workload\/$/);
    await expect(page.getByRole('switch')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Save workload settings' })).toHaveCount(0);
    const enabled = page.getByRole('switch', { name: 'Enable workload reporting', exact: true });
    const members = page.getByRole('switch', { name: 'Include members by default', exact: true });
    const pms = page.getByRole('switch', { name: 'Include PMs by default', exact: true });
    const setting = name => page.locator(`[data-workload-setting="workload_${name}"]`);
    await expect(enabled).not.toBeChecked();
    await expect(members).toHaveCount(0);
    await expect(pms).toHaveCount(0);
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await enabled.check();
    await expect(setting('enabled')).toHaveAttribute('data-enabled', 'true');
    await expect(members).toBeChecked();
    await expect(pms).not.toBeChecked();
    await members.uncheck();
    await expect(setting('members_included')).toHaveAttribute('data-enabled', 'false');
    await pms.check();
    await expect(setting('pms_included')).toHaveAttribute('data-enabled', 'true');
    await expect(page.getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    await enabled.check();
    await expect(setting('enabled')).toHaveAttribute('data-enabled', 'true');
    await expect(page.locator('#workload-categories-body tr')).toHaveCount(3);
    await expect(members).not.toBeChecked();
    await expect(pms).toBeChecked();
    await expect(page.getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Workload overview', exact: true })).toBeVisible();
    const toast = page.locator('#toast-slot .workload-settings-toast');
    await expect(toast).toContainText('Workload settings saved.');
    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast).toHaveCount(0);
    await enabled.uncheck();
    await expect(setting('enabled')).toHaveAttribute('data-enabled', 'false');
    await expect(page.getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Workload overview', exact: true })).toHaveCount(0);
    expect(navigations).toBe(0);
    await page.reload();
    await expect(enabled).not.toBeChecked();
    await expect(members).toHaveCount(0);
    await expect(pms).toHaveCount(0);
    await enabled.check();
    await expect(setting('enabled')).toHaveAttribute('data-enabled', 'true');
    await expect(members).not.toBeChecked();
    await expect(pms).toBeChecked();
    await expect(page.locator('#workload-categories-body tr')).toHaveCount(3);
    await pms.uncheck();
    await expect(setting('pms_included')).toHaveAttribute('data-enabled', 'false');
    await expect(page.getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Workload overview', exact: true })).toBeVisible();
  });

  test('workload settings switches validate values and respect workspace PM permissions', async ({ appPage: page }) => {
    await page.goto('/workspaces/workload/');
    await expect(page.getByRole('switch')).toHaveCount(1);
    const url = '/workspaces/workload/settings/workload_enabled/';
    expect((await page.request.get(url)).status()).toBe(405);
    expect(await postForm(page, url, { workload_enabled: 'invalid' })).toBe(400);
    expect(await postForm(page, '/workspaces/workload/settings/name/', { name: 'Changed' })).toBe(400);
    await signInAs(page, 'member1');
    expect(await postForm(page, url, { workload_enabled: 'on' })).toBe(403);
    await signInAs(page, 'pm2');
    expect(await postForm(page, url, { workload_enabled: 'on' })).toBe(200);
    await signInAs(page, 'demo');
    await page.goto('/workspaces/workload/');
    await expect(page.getByRole('switch', { name: 'Enable workload reporting', exact: true })).not.toBeChecked();
    expect(await postForm(page, url, { workload_enabled: 'on', workload_members_included: '', workload_pms_included: 'on' })).toBe(200);
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Enable workload reporting', exact: true })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Include members by default', exact: true })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Include PMs by default', exact: true })).not.toBeChecked();
  });

  test('workload participation table saves independent radio choices without navigation', async ({ appPage: page }) => {
    await enableWorkload(page);
    const table = page.getByRole('table', { name: 'Participation overrides', exact: true });
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText(['Person', 'Inherit', 'Included', 'Exempt']);
    const member = table.locator('[data-workload-member="member1"]');
    const manager = table.locator('[data-workload-member="demo"]');
    await expect(member.getByRole('radio')).toHaveCount(3);
    await expect(member.getByRole('radio', { name: 'Inherit', exact: true })).toBeChecked();
    await expect(manager.getByRole('radio', { name: 'Inherit', exact: true })).toBeChecked();
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await member.getByRole('radio', { name: 'Exempt', exact: true }).check();
    await expect(member).toHaveAttribute('data-participation', 'exempt');
    const toast = page.locator('#toast-slot .workload-participation-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('member1');
    await expect(toast).toContainText('Participation saved.');
    await manager.getByRole('radio', { name: 'Included', exact: true }).check();
    await expect(manager).toHaveAttribute('data-participation', 'included');
    await expect(page.getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    await expect(member.getByRole('radio', { name: 'Exempt', exact: true })).toBeChecked();
    await manager.getByRole('radio', { name: 'Exempt', exact: true }).check();
    await expect(manager).toHaveAttribute('data-participation', 'exempt');
    await expect(page.getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    await member.getByRole('radio', { name: 'Included', exact: true }).check();
    await expect(member).toHaveAttribute('data-participation', 'included');
    await member.getByRole('radio', { name: 'Inherit', exact: true }).check();
    await expect(member).toHaveAttribute('data-participation', 'inherit');
    await expect(manager.getByRole('radio', { name: 'Exempt', exact: true })).toBeChecked();
    await expect(table.getByRole('combobox')).toHaveCount(0);
    await expect(table.getByRole('button', { name: 'Save participation' })).toHaveCount(0);
    expect(navigations).toBe(0);
    await page.reload();
    await expect(member.getByRole('radio', { name: 'Inherit', exact: true })).toBeChecked();
    await expect(manager.getByRole('radio', { name: 'Exempt', exact: true })).toBeChecked();
  });

  test('workload participation radio table supports German labels and keyboard selection', async ({ appPage: page }) => {
    await enableWorkload(page);
    await page.getByRole('button', { name: 'DE', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Meldung der Arbeitsverteilung aktivieren', exact: true })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Mitglieder standardmäßig einbeziehen', exact: true })).toBeChecked();
    const pmDefault = page.getByRole('switch', { name: 'PMs standardmäßig einbeziehen', exact: true });
    await pmDefault.check();
    await expect(page.locator('[data-workload-setting="workload_pms_included"]')).toHaveAttribute('data-enabled', 'true');
    await expect(page.locator('#toast-slot .workload-settings-toast')).toContainText('Einstellungen zur Arbeitsverteilung gespeichert.');
    await pmDefault.uncheck();
    await expect(page.locator('[data-workload-setting="workload_pms_included"]')).toHaveAttribute('data-enabled', 'false');
    const table = page.getByRole('table', { name: 'Individuelle Teilnahme-Einstellungen', exact: true });
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText(['Person', 'Standard übernehmen', 'Einbezogen', 'Ausgenommen']);
    const manager = table.locator('[data-workload-member="demo"]');
    await manager.getByRole('radio', { name: 'Standard übernehmen', exact: true }).press('ArrowRight');
    await expect(manager).toHaveAttribute('data-participation', 'included');
    await expect(manager.getByRole('radio', { name: 'Einbezogen', exact: true })).toBeChecked();
    await expect(page.locator('#toast-slot .workload-participation-toast')).toContainText('Teilnahme gespeichert.');
    await manager.getByRole('radio', { name: 'Einbezogen', exact: true }).press('ArrowRight');
    await expect(manager).toHaveAttribute('data-participation', 'exempt');
    await expect(manager.getByRole('radio', { name: 'Ausgenommen', exact: true })).toBeChecked();
    await expect(table.locator('[data-workload-member="member1"]').getByRole('radio', { name: 'Standard übernehmen', exact: true })).toBeChecked();
  });

  test('workload participation radio editing validates values and enforces workspace PM permissions', async ({ appPage: page }) => {
    await enableWorkload(page);
    const member = page.locator('[data-workload-member="member1"]');
    await expect(member.getByRole('radio', { name: 'Inherit', exact: true })).toBeVisible();
    const membershipId = await member.getAttribute('data-membership-id');
    const url = `/workspaces/workload/participation/${membershipId}/`;
    expect((await page.request.get(url)).status()).toBe(405);
    expect(await postForm(page, url, { participation: 'invalid' })).toBe(400);
    await page.reload();
    await expect(member).toHaveAttribute('data-participation', 'inherit');
    await signInAs(page, 'member1');
    expect(await postForm(page, url, { participation: 'exempt' })).toBe(403);
    await signInAs(page, 'pm2');
    expect(await postForm(page, url, { participation: 'exempt' })).toBe(404);
    await signInAs(page, 'demo');
    await page.goto('/workspaces/workload/');
    await expect(member.getByRole('radio', { name: 'Inherit', exact: true })).toBeChecked();
    expect(await postForm(page, url, { participation: 'exempt' })).toBe(200);
    await page.reload();
    await expect(member.getByRole('radio', { name: 'Exempt', exact: true })).toBeChecked();
    await signInAs(page, 'member1');
    expect((await page.goto('/workload/')).status()).toBe(403);
  });

  test('workload category deletion confirms removal and preserves snapshot names and project breakdowns', async ({ appPage: page }) => {
    await enableWorkload(page);
    const categoryId = await page.locator('[data-workload-category]', { has: page.locator('input[value="Project work"]') }).getAttribute('data-workload-category');
    const row = page.locator(`[data-workload-category="${categoryId}"]`);
    await expect(row.getByRole('button', { name: 'Delete category', exact: true })).toBeVisible();
    await signInAs(page, 'member1');
    await submitWorkloadExample(page);
    await signInAs(page, 'demo');
    await page.goto('/workspaces/workload/');
    const categoryName = 'Delivery\'s "project work"';
    await row.getByLabel('Category name', { exact: true }).fill(categoryName);
    await row.getByLabel('Category name', { exact: true }).press('Tab');
    await expect(row).toHaveAttribute('data-name', categoryName);
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain(categoryName);
      expect(dialog.message()).toContain('Existing estimates and history will be preserved.');
      await dialog.dismiss();
    });
    await row.getByRole('button', { name: 'Delete category', exact: true }).click();
    await expect(row).toBeVisible();
    await expect(page.locator('#toast-slot .workload-category-deleted-toast')).toHaveCount(0);
    page.once('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: 'Delete category', exact: true }).click();
    await expect(row).toHaveCount(0);
    const toast = page.locator('#toast-slot .workload-category-deleted-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(categoryName);
    await expect(toast).toContainText('Category deleted.');
    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await page.reload();
    await expect(row).toHaveCount(0);
    await expect(page.locator('[data-workload-category]')).toHaveCount(2);
    await page.goto('/workload/overview/');
    await expect(page.locator('[data-workload-user="member1"] span[title^="Project work:"]')).toHaveAttribute('title', /Project work: 60%\nAPI Migration: 40%/);
    await expect(page.locator('#workload-averages')).toContainText('Project work: 60%');
    await signInAs(page, 'member1');
    await page.goto('/workload/');
    await expect(page.getByLabel('Project work percentage', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel(`${categoryName} percentage`, { exact: true })).toHaveCount(0);
    const latestProject = page.locator('[data-workload-history]').first().locator('span[title^="Project work:"]');
    await expect(latestProject).toHaveAttribute('title', /Project work: 60%\nAPI Migration: 40%/);
    await expect(page.locator('#workload-total')).toHaveText('40%');
    await page.getByRole('button', { name: 'Still accurate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Review date refreshed');
    await expect(latestProject).toHaveAttribute('title', /API Migration: 40%/);
    await expect(page.locator('[data-workload-history]')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Save estimate', exact: true })).toBeDisabled();
    await expect(page.locator('[data-workload-feedback]')).toHaveText('60% left to allocate');
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('90');
    await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
    await expect(page.locator('[data-workload-history]').first().locator('span[title^="Maintenance:"]')).toHaveAttribute('title', 'Maintenance: 90%');
    await expect(page.locator('[data-workload-history]').first().locator('span[title^="Project work:"]')).toHaveCount(0);
    await expect(page.locator('[data-workload-history]')).toHaveCount(3);
    await expect(page.locator('[data-workload-history]').last().locator('span[title^="Project work:"]')).toHaveAttribute('title', /Project work: 60%/);
    const history = page.locator('[data-workload-history]').last();
    await expect(history).not.toContainText('API Migration: 40%');
    await expect(history.locator('span[title^="Project work:"]')).toHaveAttribute('title', 'Project work: 60%\nAPI Migration: 40%\nUnspecified project work: 20%');
  });

  test('workload category deletion is POST-only, PM-only and workspace scoped', async ({ appPage: page }) => {
    await enableWorkload(page);
    const row = page.locator('[data-workload-category]').first();
    await expect(row.getByRole('button', { name: 'Delete category', exact: true })).toBeVisible();
    const categoryId = await row.getAttribute('data-workload-category');
    const url = `/workspaces/workload/categories/${categoryId}/delete/`;
    expect((await page.request.get(url)).status()).toBe(405);
    await signInAs(page, 'member1');
    expect(await postForm(page, url, {})).toBe(403);
    await signInAs(page, 'pm2');
    expect(await postForm(page, url, {})).toBe(404);
    await signInAs(page, 'demo');
    await page.goto('/workspaces/workload/');
    await expect(page.locator(`[data-workload-category="${categoryId}"]`)).toBeVisible();
    expect(await postForm(page, url, {})).toBe(200);
    expect(await postForm(page, url, {})).toBe(404);
    await page.reload();
    await expect(page.locator(`[data-workload-category="${categoryId}"]`)).toHaveCount(0);
    await expect(page.locator('[data-workload-category]')).toHaveCount(2);
    const add = page.locator('#workload-new-category');
    await add.getByLabel('New category', { exact: true }).fill('Maintenance');
    await add.getByRole('button', { name: 'Add category' }).click();
    const replacement = page.locator('[data-workload-category]', { has: page.locator('input[value="Maintenance"]') });
    await expect(replacement).toHaveAttribute('data-active', 'true');
    expect(await replacement.getAttribute('data-workload-category')).not.toBe(categoryId);
  });

  test('workload new category row is inside the table and uses the same columns', async ({ appPage: page }) => {
    await enableWorkload(page);
    const table = page.getByRole('table', { name: 'Categories', exact: true });
    const add = table.locator('#workload-new-category');
    await expect(add).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText(['Category name', 'Active', 'Allow project breakdown']);
    await expect(add.locator('td')).toHaveCount(3);
    await expect(add.getByLabel('Active', { exact: true })).toBeChecked();
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await add.getByLabel('New category', { exact: true }).fill('Support');
    await add.getByLabel('Active', { exact: true }).uncheck();
    await add.getByLabel('Allow project breakdown', { exact: true }).check();
    await add.getByRole('button', { name: 'Add category' }).click();
    const saved = table.locator('[data-workload-category]', { has: page.locator('input[value="Support"]') });
    await expect(saved).toHaveAttribute('data-active', 'false');
    await expect(saved).toHaveAttribute('data-supports-projects', 'true');
    await expect(table.locator('[data-workload-category]')).toHaveCount(4);
    const toast = page.locator('#toast-slot .workload-category-toast');
    await expect(toast).toContainText('Support');
    await expect(toast).toContainText('Category saved.');
    await expect(add.getByLabel('New category', { exact: true })).toHaveValue('');
    await expect(add.getByLabel('Active', { exact: true })).toBeChecked();
    await expect(add.getByLabel('Allow project breakdown', { exact: true })).not.toBeChecked();
    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await add.getByLabel('New category', { exact: true }).fill('Support');
    await add.getByRole('button', { name: 'Add category' }).click();
    await expect(add.locator('td').first().getByRole('alert')).toContainText('already exists');
    await expect(add.getByLabel('New category', { exact: true })).toHaveValue('Support');
    await expect(table.locator('[data-workload-category]')).toHaveCount(4);
    await expect(toast).toHaveCount(0);
    expect(navigations).toBe(0);
    await page.reload();
    await expect(saved).toHaveAttribute('data-active', 'false');
    await expect(saved).toHaveAttribute('data-supports-projects', 'true');
  });
  test('workload category table saves direct edits without navigating', async ({ appPage: page }) => {
    await enableWorkload(page);
    const table = page.getByRole('table', { name: 'Categories', exact: true });
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText(['Category name', 'Active', 'Allow project breakdown']);
    const categoryId = await table.locator('[data-workload-category]', { has: page.locator('input[value="Maintenance"]') }).getAttribute('data-workload-category');
    const row = table.locator(`[data-workload-category="${categoryId}"]`);
    const toast = page.locator('#toast-slot .workload-category-toast');
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await row.getByLabel('Category name', { exact: true }).fill('Operations');
    await row.getByLabel('Category name', { exact: true }).press('Tab');
    await expect(row).toHaveAttribute('data-name', 'Operations');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Operations');
    await expect(toast).toContainText('Category saved.');
    await expect(toast).toHaveClass(/\bsuccess\b/);
    await expect(toast).toHaveAttribute('role', 'status');
    await expect(row.getByRole('status')).toHaveCount(0);
    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast).toHaveCount(0);
    await row.getByLabel('Active', { exact: true }).uncheck();
    await expect(row).toHaveAttribute('data-active', 'false');
    await expect(toast).toBeVisible();
    await row.getByLabel('Allow project breakdown', { exact: true }).check();
    await expect(row).toHaveAttribute('data-supports-projects', 'true');
    await expect(toast).toHaveCount(1);
    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast).toHaveCount(0);
    await row.getByLabel('Category name', { exact: true }).fill('Project work');
    await row.getByLabel('Category name', { exact: true }).press('Tab');
    await expect(row.locator('td').first().getByRole('alert')).toContainText('already exists');
    await expect(toast).toHaveCount(0);
    await expect(row).toHaveAttribute('data-name', 'Operations');
    await expect(row.getByLabel('Category name', { exact: true })).toHaveValue('Project work');
    await row.getByLabel('Category name', { exact: true }).fill('Operations');
    await row.getByLabel('Category name', { exact: true }).press('Tab');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Category saved.');
    await expect(row.getByRole('alert')).toHaveCount(0);
    expect(navigations).toBe(0);
    await page.reload();
    await expect(row.getByLabel('Category name', { exact: true })).toHaveValue('Operations');
    await expect(row.getByLabel('Active', { exact: true })).not.toBeChecked();
    await expect(row.getByLabel('Allow project breakdown', { exact: true })).toBeChecked();
    await expect(table.getByRole('button', { name: 'Save category' })).toHaveCount(0);
  });
  test('workload rejects direct exempt submissions and foreign category/project references', async ({ appPage: page }) => {
    await enableWorkload(page);
    expect(await postForm(page, '/workload/save/', {})).toBe(403);
    await signInAs(page, 'member1');
    await page.goto('/workload/');
    const fields = await page.locator('#workload-form').evaluate(form => Object.fromEntries(new FormData(form)));
    const maintenance = await page.getByLabel('Maintenance percentage', { exact: true }).getAttribute('name');
    fields[maintenance] = '100';
    const responseText = await page.evaluate(async fields => {
      const response = await fetch('/workload/save/', { method: 'POST', body: new URLSearchParams({ ...fields, project_999999_999999: '10' }) });
      return response.text();
    }, fields);
    expect(responseText).toContain('unavailable in this workspace');
    await page.reload();
    await expect(page.locator('[data-workload-history]')).toHaveCount(0);
    expect(await postForm(page, '/workspaces/workload/', { workload_enabled: 'on' })).toBe(403);
    await submitWorkloadExample(page);
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('40');
    await page.getByLabel('Project work percentage', { exact: true }).fill('50');
    await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
    await expect(page.locator('[data-workload-history]').first().locator('span[title^="Maintenance:"]')).toHaveAttribute('title', 'Maintenance: 40%');
    await expect(page.locator('[data-workload-history]')).toHaveCount(2);
    await expect(page.locator('[data-workload-history]').last().locator('span[title^="Maintenance:"]')).toHaveAttribute('title', 'Maintenance: 30%');
    await page.goto('/');
    await signInAs(page, 'multi1');
    await page.goto('/workload/');
    await expect(page.getByLabel('Maintenance percentage', { exact: true })).toHaveValue('0');
    await expect(page.locator('[data-workload-history]')).toHaveCount(0);
  });

  test('workload retains snapshots through category archival and disabling, and filters coverage', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await submitWorkloadExample(page);
    await page.goto('/');
    await signInAs(page, 'demo');
    await page.goto('/workload/overview/');
    await page.getByLabel('Team', { exact: true }).selectOption({ label: 'Backend' });
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(page.locator('#workload-coverage')).toHaveText('1 of 1 participating members reported.');
    await page.getByLabel('Team', { exact: true }).selectOption({ label: 'Design' });
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(page.locator('#workload-coverage')).toHaveText('0 of 0 participating members reported.');
    await page.goto('/workspaces/workload/');
    const maintenanceId = await page.locator('[data-workload-category]', { has: page.locator('input[value="Maintenance"]') }).getAttribute('data-workload-category');
    const maintenance = page.locator(`[data-workload-category="${maintenanceId}"]`);
    await maintenance.getByLabel('Category name', { exact: true }).fill('Operations');
    await maintenance.getByLabel('Category name', { exact: true }).press('Tab');
    await expect(maintenance).toHaveAttribute('data-name', 'Operations');
    await maintenance.getByLabel('Active', { exact: true }).uncheck();
    await expect(maintenance).toHaveAttribute('data-active', 'false');
    const add = page.locator('#workload-add-category');
    await add.getByLabel('New category', { exact: true }).fill('Support');
    await add.getByRole('button', { name: 'Add category' }).click();
    await expect(page.locator('[data-workload-category]', { has: page.locator('input[value="Support"]') })).toHaveAttribute('data-active', 'true');
    await page.goto('/');
    await signInAs(page, 'member1');
    await page.goto('/workload/');
    await expect(page.getByLabel('Maintenance percentage', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Support percentage', { exact: true })).toHaveValue('0');
    const latestMaintenance = page.locator('[data-workload-history]').first().locator('span[title^="Maintenance:"]');
    await expect(latestMaintenance).toHaveAttribute('title', 'Maintenance: 30%');
    await page.getByRole('button', { name: 'Still accurate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Review date refreshed');
    await expect(latestMaintenance).toHaveAttribute('title', 'Maintenance: 30%');
    await page.goto('/');
    await signInAs(page, 'demo');
    await page.goto('/workspaces/workload/');
    await page.getByLabel('Enable workload reporting', { exact: true }).uncheck();
    await expect(page.locator('[data-workload-setting="workload_enabled"]')).toHaveAttribute('data-enabled', 'false');
    await page.goto('/workload/overview/');
    await expect(page.locator('[data-workload-user="member1"] span[title^="Maintenance:"]')).toHaveAttribute('title', 'Maintenance: 30%');
    await expect(page.locator('#workload-coverage')).toHaveText('0 of 0 participating members reported.');
    await page.goto('/');
    await signInAs(page, 'member1');
    expect(await postForm(page, '/workload/save/', { action: 'review' })).toBe(403);
  });

  test('workload history stays in the source workspace when a project moves or is deleted', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await submitWorkloadExample(page);
    await page.goto('/');
    await signInAs(page, 'demo');
    await page.locator('.ws-chevron-btn').click();
    await page.fill('#workspace-create-name', 'Workload destination');
    await page.locator('#workspace-create-name').press('Enter');
    await expect(page.locator('#workspace-name')).toHaveText('Workload destination');
    await enableWorkload(page);
    const destinationId = await page.locator('#workspace-menu form', { has: page.locator('.workspace-item', { hasText: 'Workload destination' }) }).getAttribute('action').then(action => action.match(/\d+/)[0]);
    await page.locator('.ws-chevron-btn').click();
    await page.locator('#workspace-menu .workspace-item', { hasText: "demo's workspace" }).click();
    await expect(page.locator('#workspace-name')).toHaveText("demo's workspace");
    const projectId = await page.locator('.project-group', { has: page.locator('.left-cell.proj', { hasText: 'API Migration' }) }).getAttribute('data-project-id');
    expect(await postForm(page, `/projects/${projectId}/move-workspace/`, { workspace_id: destinationId })).toBe(200);
    await page.goto('/workload/overview/');
    await expect(page.locator('[data-workload-user="member1"] span[title^="Project work:"]')).toHaveAttribute('title', /API Migration: 40%/);
    await page.locator('.ws-chevron-btn').click();
    await page.locator('#workspace-menu .workspace-item', { hasText: 'Workload destination' }).click();
    await expect(page.locator('#workspace-name')).toHaveText('Workload destination');
    await page.goto('/workload/overview/');
    await expect(page.locator('main')).not.toContainText('API Migration: 40%');
    expect(await postForm(page, `/projects/${projectId}/delete/`, {})).toBe(200);
    await page.goto('/');
    await page.locator('.ws-chevron-btn').click();
    await page.locator('#workspace-menu .workspace-item', { hasText: "demo's workspace" }).click();
    await expect(page.locator('#workspace-name')).toHaveText("demo's workspace");
    await signInAs(page, 'member1');
    await page.goto('/workload/');
    const latestProject = page.locator('[data-workload-history]').first().locator('span[title^="Project work:"]');
    await expect(latestProject).toHaveAttribute('title', /API Migration: 40%/);
    await page.getByRole('button', { name: 'Still accurate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Review date refreshed');
    await expect(latestProject).toHaveAttribute('title', /API Migration: 40%/);
  });
  test('workload rejects malformed percentages without a server error or a new snapshot', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/workload/');
    const fields = await page.locator('#workload-form').evaluate(form => Object.fromEntries(new FormData(form)));
    const field = await page.getByLabel('Maintenance percentage', { exact: true }).getAttribute('name');
    for (const value of ['101', '-1', '0.5', '1'.repeat(4500)]) {
      const response = await page.evaluate(async fields => {
        const r = await fetch('/workload/save/', { method: 'POST', body: new URLSearchParams(fields) });
        return { status: r.status, text: await r.text() };
      }, { ...fields, [field]: value });
      expect(response.status).toBe(200);
      expect(response.text).toContain('Percentages must be whole numbers');
    }
    await page.reload();
    await expect(page.locator('[data-workload-history]')).toHaveCount(0);
  });

  test('workload project picker defaults to assigned projects and keeps saved allocations visible', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.goto('/workload/');
    await page.getByText('Optional project breakdown', { exact: true }).click();
    const body = page.locator('.workload-projects');
    const onboarding = body.getByRole('button', { name: 'Add Onboarding revamp', exact: true });
    await expect(body.getByRole('button', { name: 'Add API Migration', exact: true })).toBeVisible();
    await expect(body.getByRole('button', { name: 'Add Infra hardening', exact: true })).toBeVisible();
    await expect(onboarding).toBeHidden();
    const showAll = body.getByLabel('Show all projects', { exact: true });
    await expect(showAll).not.toBeChecked();
    await showAll.check();
    await onboarding.click();
    const allocation = page.getByLabel('Project work: Onboarding revamp percentage', { exact: true });
    await allocation.fill('20');
    await showAll.uncheck();
    await expect(allocation).toBeVisible();
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('30');
    await page.getByLabel('Project work percentage', { exact: true }).fill('60');
    await page.getByLabel('Meetings percentage', { exact: true }).fill('10');
    await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Estimate saved');
    await page.reload();
    await expect(showAll).not.toBeChecked();
    await expect(allocation).toBeVisible();
    await expect(allocation).toHaveValue('20');
    await body.getByRole('button', { name: 'Remove Onboarding revamp', exact: true }).click();
    await expect(allocation).toBeHidden();
    await expect(onboarding).toBeHidden();
    await expect(showAll).toBeFocused();
    await showAll.check();
    await expect(onboarding).toBeVisible();
  });

  test('workload check-in with no assignments defaults to an empty project picker with an all-projects option', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'ideaeditor', { keepCheckin: true });
    const dialog = page.locator('#workload-checkin-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByText('Optional project breakdown', { exact: true }).click();
    const body = dialog.locator('.workload-projects');
    await expect(body.locator('[data-workload-project-add]:visible')).toHaveCount(0);
    await expect(body.getByText('No active projects assigned.', { exact: true })).toBeVisible();
    const showAll = body.getByLabel('Show all projects', { exact: true });
    await expect(showAll).not.toBeChecked();
    await showAll.check();
    await expect(body.locator('[data-workload-project-add]:visible')).toHaveCount(3);
    await body.getByRole('button', { name: 'Add API Migration', exact: true }).click();
    await showAll.uncheck();
    await expect(dialog.getByLabel('Project work: API Migration percentage', { exact: true })).toBeVisible();
    await expect(body.locator('[data-workload-project-add]:visible')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Submit estimate', exact: true })).toBeDisabled();
  });

  test('workload guidance includes explicit project responsibility but excludes completed projects', async ({ appPage: page }) => {
    await enableWorkload(page);
    await page.goto('/people/');
    const alex = page.locator('.person-row', { has: page.locator('input[value="Alex Chen"]') });
    const personId = (await alex.getAttribute('id')).replace('person-row-', '');
    await alex.getByText('Workload', { exact: true }).click();
    await alex.getByLabel('Workload participation', { exact: true }).selectOption('included');
    await expect(alex.locator('select[name=participation] option[value=included]')).toHaveAttribute('selected', '');
    await page.goto('/');
    const onboardingId = await page.locator('.project-group', { has: page.locator('.left-cell.proj', { hasText: 'Onboarding revamp' }) }).getAttribute('data-project-id');
    const infraId = await page.locator('.project-group', { has: page.locator('.left-cell.proj', { hasText: 'Infra hardening' }) }).getAttribute('data-project-id');
    expect(await postForm(page, `/projects/${onboardingId}/update/`, { responsible_person_ids: personId })).toBe(200);
    expect(await postForm(page, `/projects/${infraId}/set-completed/`, {})).toBe(200);
    await signInAs(page, 'member1');
    await page.goto('/workload/');
    await expect(page.locator('#workload-guidance')).toContainText('API Migration');
    await expect(page.locator('#workload-guidance')).toContainText('Onboarding revamp');
    await expect(page.locator('#workload-guidance')).not.toContainText('Infra hardening');
    await expect(page.getByLabel('Project work: Infra hardening percentage', { exact: true })).toHaveCount(0);
    await page.getByText('Optional project breakdown', { exact: true }).click();
    await expect(page.locator('.workload-projects').getByRole('button', { name: 'Add Onboarding revamp', exact: true })).toBeVisible();
    await page.locator('.workload-projects').getByLabel('Show all projects', { exact: true }).check();
    await expect(page.getByRole('button', { name: 'Add Infra hardening', exact: true })).toHaveCount(0);
  });

  test('workload configuration is workspace scoped and PMs are exempt by default', async ({ appPage: page }) => {
    await expect(page.getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    await enableWorkload(page);
    await expect(page.getByRole('link', { name: 'My workload', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Workload overview', exact: true })).toBeVisible();
    expect((await page.goto('/workload/')).status()).toBe(403);
    await page.goto('/workspaces/workload/');
    const categoryId = await page.locator('[data-workload-category]').first().getAttribute('data-workload-category');
    const member = page.locator('[data-workload-member="member1"]');
    await member.getByRole('radio', { name: 'Exempt', exact: true }).check();
    await expect(member).toHaveAttribute('data-participation', 'exempt');
    await signInAs(page, 'member1');
    expect(await postForm(page, `/workspaces/workload/categories/${categoryId}/`, { name: 'Unauthorized change' })).toBe(403);
    expect(await postForm(page, '/workspaces/workload/categories/', { name: 'Unauthorized category' })).toBe(403);
    expect((await page.goto('/workload/')).status()).toBe(403);
    expect((await page.goto('/workspaces/workload/')).status()).toBe(403);
    expect((await page.goto('/workload/overview/')).status()).toBe(403);
    await page.goto('/');
    await signInAs(page, 'pm2');
    await page.goto('/workspaces/workload/');
    await expect(page.getByLabel('Enable workload reporting', { exact: true })).not.toBeChecked();
    await expect(page.locator('[data-workload-category]')).toHaveCount(0);
    expect(await postForm(page, `/workspaces/workload/categories/${categoryId}/`, { name: 'Foreign change' })).toBe(404);
  });

  test('workload percentages validate, persist and optionally break down projects without double counting', async ({ appPage: page }) => {
    await enableWorkload(page);
    await signInAs(page, 'member1');
    await page.getByRole('link', { name: 'My Profile', exact: true }).click();
    await page.getByRole('link', { name: 'My workload', exact: true }).click();
    await expect(page.locator('#workload-guidance')).toContainText('API Migration');
    await expect(page.locator('#workload-guidance')).toContainText('Infra hardening');
    await expect(page.locator('#workload-guidance')).not.toContainText('Onboarding revamp');
    await page.getByLabel('Maintenance percentage', { exact: true }).fill('30');
    await page.getByLabel('Project work percentage', { exact: true }).fill('60');
    await page.getByLabel('Meetings percentage', { exact: true }).fill('5');
    await expect(page.getByRole('button', { name: 'Save estimate', exact: true })).toBeDisabled();
    await expect(page.locator('[data-workload-feedback]')).toHaveText('5% left to allocate');
    await page.getByLabel('Meetings percentage', { exact: true }).fill('10');
    await page.getByText('Optional project breakdown', { exact: true }).click();
    await page.locator('.workload-projects').getByRole('button', { name: 'Add API Migration', exact: true }).click();
    await page.getByLabel('Project work: API Migration percentage', { exact: true }).fill('65');
    await expect(page.getByRole('button', { name: 'Save estimate', exact: true })).toBeDisabled();
    await expect(page.locator('[data-workload-project-error]')).toContainText('exceed');
    await page.getByLabel('Project work: API Migration percentage', { exact: true }).fill('40');
    await page.locator('.workload-projects').getByLabel('Show all projects', { exact: true }).check();
    await page.locator('.workload-projects').getByRole('button', { name: 'Add Onboarding revamp', exact: true }).click();
    await page.getByLabel('Project work: Onboarding revamp percentage', { exact: true }).fill('15');
    await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Estimate saved');
    await expect(page.locator('[data-workload-history]').first().locator('span[title^="Project work:"]')).toHaveAttribute('title', /Unspecified project work: 5%/);
    await page.reload();
    await expect(page.getByLabel('Maintenance percentage', { exact: true })).toHaveValue('30');
    await page.getByRole('button', { name: 'Still accurate', exact: true }).click();
    await expect(page.locator('#workload-status')).toContainText('Review date refreshed');
    await expect(page.locator('[data-workload-history]')).toHaveCount(2);
    await page.goto('/');
    await signInAs(page, 'demo');
    await page.goto('/workload/overview/');
    await expect(page.locator('#workload-coverage')).toHaveText('1 of 3 participating members reported.');
    await expect(page.locator('#workload-averages')).toContainText('Maintenance: 30%');
    await expect(page.locator('[data-workload-user="member1"] span[title^="Project work:"]')).toHaveAttribute('title', /Unspecified project work: 5%/);
    await expect(page.locator('[data-workload-user="ideaeditor"]')).toContainText('Not reported');
    await expect(page.locator('[data-workload-user="demo"]')).toContainText('Exempt');
  });
});

test.describe('self-service profile', () => {
  test('profile omits the public roadmap link even when the roadmap is enabled', async ({ appPage: page }) => {
    const roadmapUrl = await enableRoadmap(page);
    await page.goto('/profile/');
    await expect(page.getByRole('link', { name: 'Open public roadmap', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Change password', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'DE', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Mein Profil', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Öffentliche Roadmap öffnen', exact: true })).toHaveCount(0);
    expect((await page.request.get(roadmapUrl)).status()).toBe(200);
  });

  test('profile edits personal fields and a clearly named Teams email address', async ({ appPage: page }) => {
    const link = page.locator('.sidebar-user .user-name');
    await expect(link).toHaveAttribute('href', '/profile/');
    await link.click();
    await expect(page.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible();
    await expect(page.getByLabel('Username', { exact: true })).toHaveAttribute('readonly', '');
    await page.getByLabel('First name', { exact: true }).fill('Demo');
    await page.getByLabel('Last name', { exact: true }).fill('User');
    await page.getByLabel('Email address', { exact: true }).fill('contact@example.com');
    await page.getByLabel('Teams email address', { exact: true }).fill('DEMO@teams.example.com');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Profile saved.');
    await page.reload();
    await expect(page.getByLabel('First name', { exact: true })).toHaveValue('Demo');
    await expect(page.getByLabel('Last name', { exact: true })).toHaveValue('User');
    await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('contact@example.com');
    await expect(page.getByLabel('Teams email address', { exact: true })).toHaveValue('demo@teams.example.com');
    const workspace = await page.locator('#profile-form input[name=workspace_id]').inputValue();
    // Browser validation bypass: invalid Teams address must not partially save account fields.
    expect(await postForm(page, '/profile/', {
      first_name: 'Should not persist', email: 'contact@example.com', teams_upn: 'not-an-address', workspace_id: workspace,
    })).toBe(200);
    await page.reload();
    await expect(page.getByLabel('First name', { exact: true })).toHaveValue('Demo');
    await expect(page.getByLabel('Teams email address', { exact: true })).toHaveValue('demo@teams.example.com');
    // Clearing optional names belongs to profile persistence coverage, not
    // four repeated profile-edit cycles in the Teams actor-formatting test.
    await page.getByLabel('First name', { exact: true }).fill('');
    await page.getByLabel('Last name', { exact: true }).fill('');
    await page.getByLabel('Teams email address', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await page.reload();
    await expect(page.getByLabel('First name', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Last name', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Teams email address', { exact: true })).toHaveValue('');
    await page.goto('/workspaces/teams/');
    await expect(page.getByLabel('Teams email address', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Set up new webhook', exact: true })).toBeVisible();
    await expect(page.getByLabel('Microsoft Teams webhook URL')).not.toBeVisible();
  });

  test('profile remains self-service for members without exposing PM Teams settings', async ({ page, request, browser }) => {
    await reset(request);
    const anonymous = await request.get('/profile/', { maxRedirects: 0 });
    expect(anonymous.status()).toBe(302);
    expect(anonymous.headers().location).toContain('/accounts/login/');
    await page.goto('/accounts/login/');
    await page.locator('input[name=username]').fill('member1');
    await page.locator('input[name=password]').fill('member1');
    await page.locator('button[type=submit]').click();
    await page.waitForURL('/');
    await expect(page.getByRole('link', { name: 'Teams notifications', exact: true })).toHaveCount(0);
    await page.locator('.sidebar-user .user-name').click();
    const workspace = await page.locator('#profile-form input[name=workspace_id]').inputValue();
    expect(await postForm(page, '/profile/', {
      first_name: 'Member', last_name: 'Updated', email: 'member@example.com', teams_upn: 'member@teams.example.com', workspace_id: workspace,
      username: 'demo', user_id: '1', is_staff: 'true', is_superuser: 'true', role: 'pm',
    })).toBe(200);
    await page.reload();
    await expect(page.getByLabel('Username', { exact: true })).toHaveValue('member1');
    await expect(page.getByLabel('First name', { exact: true })).toHaveValue('Member');
    await expect(page.getByLabel('Teams email address', { exact: true })).toHaveValue('member@teams.example.com');
    for (const action of ['workspace', 'webhook', 'disconnect', 'public_subscribers']) {
      expect(await postForm(page, '/workspaces/teams/', { action, teams_webhook_url: 'https://example.com' })).toBe(403);
    }
    const denied = await page.goto('/workspaces/teams/');
    expect(denied.status()).toBe(403);
    const otherContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await login(other);
      await other.goto('/profile/');
      await expect(other.getByLabel('First name', { exact: true })).toHaveValue('');
      await expect(other.getByLabel('Teams email address', { exact: true })).toHaveValue('');
    } finally { await otherContext.close(); }
  });

  test('profile Teams email stays workspace-specific and rejects stale workspace submissions', async ({ appPage: page }) => {
    await saveTeamsIdentity(page, 'original@example.com');
    const sourceWorkspace = await page.locator('#profile-form input[name=workspace_id]').inputValue();
    await page.locator('.ws-chevron-btn').click();
    await page.locator('#workspace-create-name').fill('Another workspace');
    await page.locator('#workspace-menu button', { hasText: 'Create' }).click();
    await page.waitForURL('/');
    await page.goto('/profile/');
    await expect(page.getByLabel('Teams email address', { exact: true })).toHaveValue('');
    expect(await postForm(page, '/profile/', { workspace_id: sourceWorkspace, teams_upn: 'wrong@example.com', first_name: 'Stale' })).toBe(200);
    await page.reload();
    await expect(page.getByLabel('Teams email address', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('First name', { exact: true })).toHaveValue('');
    await saveTeamsIdentity(page, 'other@example.com');
    await page.locator('.ws-chevron-btn').click();
    await page.locator('#workspace-menu .workspace-item', { hasText: "demo's workspace" }).click();
    await page.waitForURL('/');
    await page.goto('/profile/');
    await expect(page.getByLabel('Teams email address', { exact: true })).toHaveValue('original@example.com');
  });

  test('profile password changes verify the old password and preserve the current session', async ({ appPage: page }) => {
    await page.goto('/profile/');
    await expect(page.getByRole('link', { name: 'Change password', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Change password', exact: true }).click();
    const password = 'N4no-Updated-Passphrase!2026';
    await page.locator('input[name=old_password]').fill('wrong');
    await page.locator('input[name=new_password1]').fill(password);
    await page.locator('input[name=new_password2]').fill(password);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(page.locator('#password-form .errorlist')).toContainText('Your old password was entered incorrectly.');
    await page.locator('input[name=old_password]').fill('demo');
    await page.locator('input[name=new_password1]').fill('123');
    await page.locator('input[name=new_password2]').fill('123');
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(page.locator('#password-form .errorlist')).toContainText('This password is too short.');
    await page.locator('input[name=old_password]').fill('demo');
    await page.locator('input[name=new_password1]').fill(password);
    await page.locator('input[name=new_password2]').fill(password);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await page.waitForURL('/profile/');
    await expect(page.getByRole('status')).toContainText('Password changed.');
    await expect(page.getByLabel('Username', { exact: true })).toHaveValue('demo');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto('/accounts/login/');
    await page.locator('input[name=username]').fill('demo');
    await page.locator('input[name=password]').fill('demo');
    await page.locator('button[type=submit]').click();
    await expect(page.locator('.login-card .error')).toBeVisible();
    await page.locator('input[name=username]').fill('demo');
    await page.locator('input[name=password]').fill(password);
    await page.locator('button[type=submit]').click();
    await page.waitForURL('/');
  });

  test('profile uses understandable German Teams email wording', async ({ appPage: page }) => {
    await page.goto('/profile/');
    await expect(page.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible();
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    await expect(page.getByRole('heading', { name: 'Mein Profil', exact: true })).toBeVisible();
    await expect(page.getByLabel('Teams-E-Mail-Adresse', { exact: true })).toBeVisible();
    await expect(page.locator('#profile-form')).not.toContainText('UPN');
    await expect(page.locator('#profile-form')).toContainText('Verwende die E-Mail-Adresse, mit der du dich für diesen Arbeitsbereich bei Microsoft Teams anmeldest.');
    await expect(page.locator('body')).toContainText('Dein Name und deine Kontakt-E-Mail gelten für dein Konto');
    await expect(page.locator('body')).toContainText('Dein Benutzername für die Anmeldung kann hier nicht geändert werden.');
  });
});

test.describe('workspace Teams subscriptions', () => {
  test('Teams summaries debounce until 15 minutes after the last change and merge milestones', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await configureTeams(page, webhook.url);
      await page.goto('/');
      const milestone = page.locator('.milestone[data-title="v2 API beta"]');
      const id = await milestone.getAttribute('data-milestone-id');
      const projectId = await milestone.getAttribute('data-project-id');
      expect(await postForm(page, `/milestones/${id}/update/`, { title: 'First pending title' })).toBe(200);
      await deliverTeamsNotifications({ advance: false });
      expect(webhook.requests).toHaveLength(0);
      const first = JSON.parse(await notificationDB(`
b = NotificationBatch.objects.get(status='open')
assert (b.send_after - b.last_changed_at).total_seconds() == 900
print(json.dumps({'id': b.id, 'send_after': b.send_after.isoformat()}))`));
      // No-op saves do not restart the timer.
      expect(await postForm(page, `/milestones/${id}/update/`, { title: 'First pending title' })).toBe(200);
      await notificationDB(`assert NotificationBatch.objects.get(status='open').send_after.isoformat() == '${first.send_after}'`);
      // No maximum wait, even beyond normal delivery retention.
      await notificationDB("NotificationBatch.objects.update(created_at=timezone.now()-timedelta(days=45), send_after=timezone.now()-timedelta(seconds=1))");
      expect(await postForm(page, `/milestones/${id}/update/`, { title: 'Final pending title' })).toBe(200);
      await deliverTeamsNotifications({ advance: false });
      expect(webhook.requests).toHaveLength(0);
      await notificationDB(`
b = NotificationBatch.objects.get(status='open')
assert b.id == ${first.id}
assert b.send_after.isoformat() > '${first.send_after}'
assert (b.send_after - b.last_changed_at).total_seconds() == 900
assert TeamsDelivery.objects.count() == 0`);
      // A second milestone in the same project belongs to the same summary.
      expect(await postForm(page, `/projects/${projectId}/milestones/`, { date: '2027-02-01' })).toBe(200);
      await page.reload();
      const secondId = await page.locator('.milestone[data-title="New milestone"]').getAttribute('data-milestone-id');
      expect(await postForm(page, `/milestones/${secondId}/update/`, { title: 'Second milestone', description: 'Details' })).toBe(200);
      // Creation is disabled, but subsequent detail edits are enabled.
      expect(await postForm(page, `/milestones/${secondId}/update/`, { title: 'Second final title' })).toBe(200);
      await page.goto('/workspaces/teams/');
      await expect(page.locator('#notification-batches')).toContainText('API Migration');
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      const text = JSON.stringify(webhook.requests[0].json);
      expect(text).toContain('Final pending title');
      expect(text).toContain('Second final title');
      expect(text).not.toContain('First pending title');
      await deliverTeamsNotifications({ advance: false });
      expect(webhook.requests).toHaveLength(1);
    } finally { await webhook.close(); }
  });

  for (const moveVia of ['editor', 'drag']) {
    test(`Teams pending move reason is prefilled and replaced via ${moveVia}`, async ({ appPage: page }) => {
      const webhook = await startWebhookServer();
      try {
        await configureTeams(page, webhook.url);
        await page.goto('/');
        const milestone = page.locator('.milestone[data-title="v2 API beta"]');
        const id = await milestone.getAttribute('data-milestone-id');
        const original = await milestone.getAttribute('data-date');
        const shift = days => {
          const date = new Date(`${original}T00:00:00Z`);
          date.setUTCDate(date.getUTCDate() + days);
          return date.toISOString().slice(0, 10);
        };
        expect(await postForm(page, `/milestones/${id}/move/`, { date: shift(2), reason: 'Initial reason' })).toBe(200);
        expect(await postForm(page, `/milestones/${id}/update/`, { description: 'Unrelated detail edit' })).toBe(200);
        await page.reload();
        const openMove = async () => {
          await milestone.scrollIntoViewIfNeeded();
          const box = await milestone.boundingBox();
          if (moveVia === 'editor') {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            const next = new Date(`${await milestone.getAttribute('data-date')}T00:00:00Z`);
            next.setUTCDate(next.getUTCDate() + 2);
            await page.locator('#milestone-popover input[name=date]').fill(next.toISOString().slice(0, 10));
            await page.locator('#milestone-popover button[type=submit]').click();
          } else {
            const ppd = Number(await page.locator('#grid-scroll').getAttribute('data-px-per-day'));
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 2 * ppd, box.y + box.height / 2, { steps: 8 });
            await page.mouse.up();
          }
          await expect(page.locator('#milestone-move-dialog')).toBeVisible();
        };
        await openMove();
        const dialog = page.locator('#milestone-move-dialog');
        await expect(dialog.locator('textarea[name=reason]')).toHaveValue('Initial reason');
        await dialog.locator('textarea[name=reason]').fill('Cancelled draft');
        await dialog.getByRole('button', { name: 'Keep original date', exact: true }).click();
        await expect(milestone).toHaveAttribute('data-date', shift(2));
        await openMove();
        await expect(dialog.locator('textarea[name=reason]')).toHaveValue('Initial reason');
        await dialog.locator('textarea[name=reason]').fill('Final reason');
        await dialog.getByRole('button', { name: 'Move milestone' }).click();
        await expect(milestone).toHaveAttribute('data-date', shift(4));
        await deliverTeamsNotifications({ advance: false });
        expect(webhook.requests).toHaveLength(0);
        await deliverTeamsNotifications();
        expect(webhook.requests).toHaveLength(1);
        const card = JSON.stringify(webhook.requests[0].json);
        expect(card).toContain('Final reason');
        expect(card).toContain('4 Tage später');
        expect(card).not.toContain('Initial reason');
        expect(card).not.toContain('Cancelled draft');
        // No reload: opening must recheck whether a worker froze the reason.
        await openMove();
        await expect(dialog.locator('textarea[name=reason]')).toHaveValue('');
      } finally { await webhook.close(); }
    });
  }

  test('Teams pending reason lookup is workspace and destination scoped', async ({ appPage: page, browser }) => {
    await configureTeams(page, 'http://127.0.0.1:54321/first');
    await page.goto('/');
    const milestone = page.locator('.milestone[data-title="v2 API beta"]');
    const id = await milestone.getAttribute('data-milestone-id');
    const date = new Date(`${await milestone.getAttribute('data-date')}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 2);
    expect(await postForm(page, `/milestones/${id}/move/`, { date: date.toISOString().slice(0, 10), reason: 'Private pending reason' })).toBe(200);
    const endpoint = `/milestones/${id}/pending-reason/`;
    const own = await page.request.get(endpoint);
    expect(await own.json()).toEqual({ reason: 'Private pending reason' });
    expect(own.headers()['cache-control']).toContain('no-store');
    const context = await browser.newContext();
    try {
      const other = await context.newPage();
      await other.goto('/accounts/login/');
      await other.locator('input[name=username]').fill('pm2');
      await other.locator('input[name=password]').fill('pm2');
      await other.locator('button[type=submit]').click();
      await other.waitForURL('/');
      const outside = await other.request.get(endpoint);
      expect(outside.status()).toBe(404);
      expect(await outside.json()).toEqual({ reason: '' });
    } finally { await context.close(); }
    await configureTeams(page, 'http://127.0.0.1:54321/second');
    expect(await (await page.request.get(endpoint)).json()).toEqual({ reason: '' });
  });

  test('Teams frozen deliveries stay immutable while subsequent moves form a new batch', async ({ appPage: page }) => {
    const webhook = await startWebhookServer([429, 200]);
    try {
      await configureTeams(page, webhook.url);
      await page.goto('/');
      const milestone = page.locator('.milestone[data-title="v2 API beta"]');
      const id = await milestone.getAttribute('data-milestone-id');
      const original = await milestone.getAttribute('data-date');
      const shift = days => {
        const date = new Date(`${original}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + days);
        return date.toISOString().slice(0, 10);
      };
      expect(await postForm(page, `/milestones/${id}/move/`, { date: shift(2), reason: 'Frozen reason' })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      await notificationDB("TeamsDelivery.objects.filter(status='pending').update(available_at=timezone.now()+timedelta(hours=1))");
      expect(await postForm(page, `/milestones/${id}/move/`, { date: shift(4), reason: 'New batch reason' })).toBe(200);
      await notificationDB(`
assert NotificationBatch.objects.filter(status='open').count() == 1
c = NotificationChange.objects.get()
assert c.before['date'] == '${shift(2)}'
assert c.latest_move_reason == 'New batch reason'
assert 'Frozen reason' in json.dumps(TeamsDelivery.objects.get().payload)
assert 'New batch reason' not in json.dumps(TeamsDelivery.objects.get().payload)
TeamsDelivery.objects.filter(status='pending').update(available_at=timezone.now())`);
      await deliverTeamsNotifications({ advance: false });
      expect(webhook.requests).toHaveLength(2);
      expect(webhook.requests[1].json).toEqual(webhook.requests[0].json);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(3);
      const last = JSON.stringify(webhook.requests[2].json);
      expect(last).toContain('New batch reason');
      expect(last).toContain('2 Tage später');
      expect(last).not.toContain('Frozen reason');
    } finally { await webhook.close(); }
  });

  test('Teams pending transfers preserve the original baseline and move into the target project summary', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await configureTeams(page, webhook.url, ['milestone.updated', 'milestone.project_changed']);
      await page.goto('/');
      const milestone = page.locator('.milestone[data-title="v2 API beta"]');
      const id = await milestone.getAttribute('data-milestone-id');
      const taskId = await milestone.getAttribute('data-task-id');
      const target = await page.locator('.left-cell.proj', { hasText: 'Onboarding revamp' }).getAttribute('data-project-id');
      expect(await postForm(page, `/milestones/${id}/update/`, { title: 'Renamed before transfer' })).toBe(200);
      expect(await postForm(page, `/tasks/${taskId}/update/`, { project_id: target })).toBe(200);
      await notificationDB(`
c = NotificationChange.objects.get()
assert c.before['title'] == 'v2 API beta'
assert c.before['project'] == 'API Migration'
assert c.after['project'] == 'Onboarding revamp'
assert c.batch.project_key == ${target}
assert NotificationBatch.objects.filter(status='open').count() == 1`);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      const text = JSON.stringify(webhook.requests[0].json);
      expect(text).toContain('Projekt: API Migration → Onboarding revamp');
      expect(text).toContain('Bisheriger Titel: v2 API beta');
      expect(text).toContain('Renamed before transfer');
    } finally { await webhook.close(); }
  });

  test('Teams pending deletion summaries survive deleting the entire project', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await configureTeams(page, webhook.url, ['milestone.updated', 'milestone.deleted']);
      await page.goto('/');
      const milestone = page.locator('.milestone[data-title="v2 API beta"]');
      const projectId = await milestone.getAttribute('data-project-id');
      expect(await postForm(page, `/projects/${projectId}/delete/`, {})).toBe(200);
      await deliverTeamsNotifications({ advance: false });
      expect(webhook.requests).toHaveLength(0);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      expect(webhook.requests[0].json.summary).toBe('API Migration · Meilenstein gelöscht · v2 API beta');
    } finally { await webhook.close(); }
  });

  test('Teams summaries discard reverted changes and milestones created then deleted', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await configureTeams(page, webhook.url, ['milestone.created', 'milestone.deleted', 'milestone.updated', 'milestone.moved']);
      await page.goto('/');
      const milestone = page.locator('.milestone[data-title="v2 API beta"]');
      const id = await milestone.getAttribute('data-milestone-id');
      const projectId = await milestone.getAttribute('data-project-id');
      const date = await milestone.getAttribute('data-date');
      expect(await postForm(page, `/milestones/${id}/update/`, { title: 'Temporary title', description: 'Temporary description' })).toBe(200);
      // Load original description from the baseline snapshot rather than seed assumptions.
      const before = JSON.parse(await notificationDB('print(json.dumps(NotificationChange.objects.get().before))'));
      expect(await postForm(page, `/milestones/${id}/update/`, { title: before.title, description: before.description })).toBe(200);
      const moved = new Date(`${date}T00:00:00Z`);
      moved.setUTCDate(moved.getUTCDate() + 2);
      expect(await postForm(page, `/milestones/${id}/move/`, { date: moved.toISOString().slice(0, 10), reason: 'Temporary reason' })).toBe(200);
      expect(await postForm(page, `/milestones/${id}/move/`, { date, reason: 'Reverted' })).toBe(200);
      await page.reload();
      const pendingReason = await page.request.get(`/milestones/${id}/pending-reason/`);
      expect(await pendingReason.json()).toEqual({ reason: '' });
      expect(await postForm(page, `/projects/${projectId}/milestones/`, { date })).toBe(200);
      await page.reload();
      const createdId = await page.locator('.milestone[data-title="New milestone"]').getAttribute('data-milestone-id');
      expect(await postForm(page, `/milestones/${createdId}/update/`, { title: 'Temporary creation' })).toBe(200);
      expect(await postForm(page, `/milestones/${createdId}/delete/`, {})).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(0);
      await notificationDB("assert NotificationBatch.objects.filter(status='open').count() == 0\nassert TeamsDelivery.objects.count() == 0");
    } finally { await webhook.close(); }
  });
  test('anonymous followers remember a validated email for subsequent follows in the same roadmap', async ({ appPage: page, browser }) => {
    await page.goto('/workspaces/teams/');
    await page.getByLabel('Allowed domains for public followers').fill('mycompany.com');
    await page.getByRole('button', { name: 'Save public follower settings', exact: true }).click();
    const roadmap = await enableRoadmap(page);
    const context = await browser.newContext();
    const otherContext = await browser.newContext();
    try {
      const visitor = await context.newPage();
      await visitor.goto(roadmap);
      const key = `nano-roadmap-email:${await visitor.locator('[data-roadmap]').getAttribute('data-roadmap-key')}`;
      const project = name => visitor.locator('[data-project-subscription]', { hasText: name });
      const dialog = visitor.getByRole('dialog', { name: 'Follow project', exact: true });
      await project('API Migration').getByRole('button', { name: 'Follow', exact: true }).click();
      await dialog.getByLabel('Teams email address', { exact: true }).fill('visitor@wrongcompany.com');
      await dialog.getByRole('button', { name: 'Follow', exact: true }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      expect(await visitor.evaluate(key => localStorage.getItem(key), key)).toBeNull();
      await dialog.getByLabel('Teams email address', { exact: true }).fill('VISITOR@MYCOMPANY.COM');
      await dialog.getByRole('button', { name: 'Follow', exact: true }).click();
      await expect(project('API Migration').getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      await expect.poll(() => visitor.evaluate(key => localStorage.getItem(key), key)).toBe('visitor@mycompany.com');
      await visitor.reload();
      await project('Onboarding revamp').getByRole('button', { name: 'Follow', exact: true }).click();
      await expect(project('Onboarding revamp').getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      await expect(dialog).not.toBeVisible();
      const other = await otherContext.newPage();
      await other.goto(roadmap);
      expect(await other.content()).not.toContain('visitor@mycompany.com');
      expect(await other.evaluate(key => localStorage.getItem(key), key)).toBeNull();
      await visitor.getByRole('button', { name: 'Use another email address', exact: true }).click();
      expect(await visitor.evaluate(key => localStorage.getItem(key), key)).toBeNull();
      await project('Infra hardening').getByRole('button', { name: 'Follow', exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Teams email address', { exact: true })).toHaveValue('');
      await dialog.getByLabel('Teams email address', { exact: true }).fill('another@mycompany.com');
      await dialog.getByRole('button', { name: 'Follow', exact: true }).click();
      await expect(project('Infra hardening').getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      await expect.poll(() => visitor.evaluate(key => localStorage.getItem(key), key)).toBe('another@mycompany.com');
    } finally { await context.close(); await otherContext.close(); }
  });

  test('cached anonymous email addresses are still checked against current domain restrictions', async ({ appPage: page, browser }) => {
    await page.goto('/workspaces/teams/');
    await page.getByLabel('Allowed domains for public followers').fill('mycompany.com');
    await page.getByRole('button', { name: 'Save public follower settings', exact: true }).click();
    const roadmap = await enableRoadmap(page);
    const context = await browser.newContext();
    try {
      const visitor = await context.newPage();
      await visitor.goto(roadmap);
      const key = `nano-roadmap-email:${await visitor.locator('[data-roadmap]').getAttribute('data-roadmap-key')}`;
      await visitor.evaluate(key => localStorage.setItem(key, 'old@anothercompany.com'), key);
      await visitor.reload();
      const project = visitor.locator('[data-project-subscription]', { hasText: 'API Migration' });
      await project.getByRole('button', { name: 'Follow', exact: true }).click();
      const dialog = visitor.getByRole('dialog', { name: 'Follow project', exact: true });
      await expect(dialog.getByRole('alert')).toContainText('Use a Teams email address from an allowed domain.');
      expect(await visitor.evaluate(key => localStorage.getItem(key), key)).toBe('old@anothercompany.com');
      await dialog.getByLabel('Teams email address', { exact: true }).fill('new@mycompany.com');
      await dialog.getByRole('button', { name: 'Follow', exact: true }).click();
      await expect(project.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      await expect.poll(() => visitor.evaluate(key => localStorage.getItem(key), key)).toBe('new@mycompany.com');
    } finally { await context.close(); }
  });

  test('roadmap follow controls sit beside each timeline project name', async ({ appPage: page }) => {
    const roadmap = await enableRoadmap(page);
    await page.goto(roadmap);
    await expect(page.locator('.roadmap-sidebar, #roadmap-project-filter')).toHaveCount(0);
    const card = page.locator('.roadmap-project-label [data-project-subscription]', { hasText: 'API Migration' });
    await expect(card.getByRole('heading', { name: 'API Migration', exact: true })).toBeVisible();
    await expect(card).not.toContainText('Move public API traffic to the new v2 platform.');
    const expectSameLine = async (control) => {
      await expect(card).toHaveCSS('display', 'flex');
      const nameBox = await card.getByRole('button', { name: 'API Migration', exact: true }).boundingBox();
      const controlBox = await control.boundingBox();
      expect(controlBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width);
      expect(controlBox.y).toBeCloseTo(nameBox.y, 0);
    };
    await expectSameLine(card.getByRole('button', { name: 'Follow', exact: true }));
    await card.getByRole('button', { name: 'Follow', exact: true }).click();
    const subscribed = card.getByRole('button', { name: 'Subscribed', exact: true });
    await expect(subscribed).toBeVisible();
    await expectSameLine(subscribed);
    await expect(card.getByRole('button', { name: 'Unfollow', exact: true })).not.toBeVisible();
    await subscribed.click();
    await expect(card.getByRole('button', { name: 'Unfollow', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card.getByRole('button', { name: 'Unfollow', exact: true })).not.toBeVisible();
    await expect(subscribed).toBeFocused();
    await subscribed.click();
    await page.getByRole('heading', { name: "demo's workspace Roadmap", exact: true }).click();
    await expect(card.getByRole('button', { name: 'Unfollow', exact: true })).not.toBeVisible();
    await subscribed.click();
    await card.getByRole('button', { name: 'Unfollow', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
  });

  test('anonymous subscriptions are browser-owned even after login', async ({ appPage: page, browser }) => {
    const context = await browser.newContext();
    const otherContext = await browser.newContext();
    const visitor = await context.newPage();
    const other = await otherContext.newPage();
    try {
      await page.goto('/workspaces/teams/');
      await page.getByLabel('Allowed domains for public followers').fill('mycompany.com');
      await page.getByRole('button', { name: 'Save public follower settings', exact: true }).click();
      await expect(page.getByLabel('Allowed domains for public followers')).toHaveValue('mycompany.com');
      const roadmap = await enableRoadmap(page);
      await visitor.goto(roadmap);
      const project = visitor.locator('[data-project-subscription]', { hasText: 'API Migration' });
      const action = await project.getAttribute('action');
      await project.getByRole('button', { name: 'Follow', exact: true }).click();
      const dialog = visitor.getByRole('dialog', { name: 'Follow project', exact: true });
      await dialog.getByLabel('Teams email address', { exact: true }).fill('VISITOR@MYCOMPANY.COM');
      await dialog.getByRole('button', { name: 'Follow', exact: true }).click();
      await visitor.waitForURL(roadmap);
      await expect(project.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      await visitor.reload();
      await expect(project.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      expect(await postForm(visitor, action, { action: 'follow', teams_email: 'visitor@mycompany.com' })).toBe(200);
      await other.goto(roadmap);
      expect(await other.content()).not.toContain('visitor@mycompany.com');
      expect(await postForm(other, action, { action: 'unfollow', teams_email: 'visitor@mycompany.com' })).toBe(200);
      await visitor.goto(roadmap);
      await expect(project.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      expect((await visitor.request.post(action, { form: { action: 'unfollow' } })).status()).toBe(403);
      // Logging in must not hide or strand the subscription owned by this browser.
      await login(visitor);
      await visitor.goto(roadmap);
      await expect(project.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      await unfollowProject(project);
      await expect(project.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
    } finally { await context.close(); await otherContext.close(); }
  });

  test('anonymous following works by default and optional domains restrict new mentions', async ({ appPage: page, browser }) => {
    const webhook = await startWebhookServer();
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      const milestoneId = await page.locator('.milestone[data-title="v2 API beta"]').first().getAttribute('data-milestone-id');
      await configureTeams(page, webhook.url, ['milestone.updated']);
      const roadmap = await enableRoadmap(page);
      await page.goto(roadmap);
      const action = await page.locator('[data-project-subscription]', { hasText: 'API Migration' }).getAttribute('action');
      await visitor.goto(roadmap);
      await expect(visitor.getByRole('link', { name: 'Sign in to follow projects' })).toHaveCount(0);
      const project = visitor.locator('[data-project-subscription]', { hasText: 'API Migration' });
      await project.getByRole('button', { name: 'Follow', exact: true }).click();
      const dialog = visitor.getByRole('dialog', { name: 'Follow project', exact: true });
      await dialog.getByLabel('Teams email address', { exact: true }).fill('visitor@othercompany.com');
      await dialog.getByRole('button', { name: 'Follow', exact: true }).click();
      await expect(project.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'Unrestricted public follow' })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests[0].json.attachments[0].content.msteams.entities.map(e => e.mentioned.id)).toEqual(['visitor@othercompany.com']);
      await page.goto('/workspaces/teams/');
      for (const domain of ['*.mycompany.com', 'https://mycompany.com', '@mycompany.com']) {
        await page.getByLabel('Allowed domains for public followers').fill(domain);
        await page.getByRole('button', { name: 'Save public follower settings', exact: true }).click();
        await expect(page.locator('#teams-public-followers-form .errorlist')).toBeVisible();
      }
      await page.getByLabel('Allowed domains for public followers').fill('MYCOMPANY.COM, mycompany.com');
      await page.getByRole('button', { name: 'Save public follower settings', exact: true }).click();
      await expect(page.getByLabel('Allowed domains for public followers')).toHaveValue('mycompany.com');
      await visitor.goto(roadmap);
      for (const address of ['visitor@othercompany.com', 'visitor@evilmycompany.com', 'visitor@sub.mycompany.com', 'visitor@mycompany.com.evil.net']) {
        expect(await postForm(visitor, action, { action: 'follow', teams_email: address })).toBe(400);
      }
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'Restricted public follow' })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(2);
      expect(webhook.requests[1].json.attachments[0].content.msteams).toBeUndefined();
      await page.getByLabel('Allowed domains for public followers').fill('');
      await page.getByRole('button', { name: 'Save public follower settings', exact: true }).click();
      await expect(page.getByLabel('Allowed domains for public followers')).toHaveValue('');
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'Restriction removed' })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(3);
      expect(webhook.requests[2].json.attachments[0].content.msteams.entities.map(e => e.mentioned.id)).toEqual(['visitor@othercompany.com']);
      await visitor.goto(roadmap);
      await unfollowProject(project);
      await expect(project.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
    } finally { await context.close(); await webhook.close(); }
  });

  test('anonymous subscriptions stay scoped to the public token and never follow projects across workspaces', async ({ appPage: page, browser }) => {
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      const projectId = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
      await page.goto('/profile/');
      const sourceId = await page.locator('#profile-form input[name=workspace_id]').inputValue();
      await page.goto('/workspaces/teams/');
      await page.getByLabel('Allowed domains for public followers').fill('mycompany.com');
      await page.getByRole('button', { name: 'Save public follower settings', exact: true }).click();
      const sourceRoadmap = await enableRoadmap(page);
      const sourceAction = `${sourceRoadmap}projects/${projectId}/follow/`;
      await visitor.goto(sourceRoadmap);
      expect(await postForm(visitor, sourceAction, { action: 'follow', teams_email: 'visitor@mycompany.com' })).toBe(200);
      expect(await postForm(page, '/workspaces/', { name: 'Another public channel' })).toBe(200);
      await page.goto('/profile/');
      const targetId = await page.locator('#profile-form input[name=workspace_id]').inputValue();
      await page.goto('/workspaces/teams/');
      await page.getByLabel('Allowed domains for public followers').fill('mycompany.com');
      await page.getByRole('button', { name: 'Save public follower settings', exact: true }).click();
      const targetRoadmap = await enableRoadmap(page);
      expect(await postForm(visitor, `${targetRoadmap}projects/${projectId}/follow/`, { action: 'follow', teams_email: 'visitor@mycompany.com' })).toBe(404);
      expect(await postForm(page, `/workspaces/${sourceId}/switch/`, {})).toBe(200);
      expect(await postForm(page, `/projects/${projectId}/move-workspace/`, { workspace_id: targetId })).toBe(200);
      expect(await postForm(visitor, sourceAction, { action: 'follow', teams_email: 'visitor@mycompany.com' })).toBe(404);
      await visitor.goto(targetRoadmap);
      await expect(visitor.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
      await expect(visitor.getByRole('button', { name: 'Unfollow', exact: true })).toHaveCount(0);
      expect(await postForm(page, `/workspaces/${targetId}/switch/`, {})).toBe(200);
      expect(await postForm(page, '/workspaces/public-roadmap/', { action: 'disable' })).toBe(200);
      expect(await postForm(visitor, `${targetRoadmap}projects/${projectId}/follow/`, { action: 'follow', teams_email: 'visitor@mycompany.com' })).toBe(404);
    } finally { await context.close(); }
  });

  test('Teams webhook actions configure and replace connections independently of event settings', async ({ appPage: page }) => {
    const first = await startWebhookServer();
    const replacement = await startWebhookServer();
    try {
      const milestoneId = await page.locator('.milestone').first().getAttribute('data-milestone-id');
      await page.goto('/workspaces/teams/');
      const setup = page.getByRole('button', { name: 'Set up new webhook', exact: true });
      await expect(setup).toBeVisible();
      await expect(page.getByLabel('Microsoft Teams webhook URL')).not.toBeVisible();
      await expect(page.locator('input[name=disconnect]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Disconnect webhook', exact: true })).toHaveCount(0);
      for (const input of await page.locator('input[name=teams_notify_events]').all()) {
        await input.setChecked((await input.getAttribute('value')) === 'milestone.updated');
      }
      await page.getByRole('button', { name: 'Save workspace notifications' }).click();
      const dialog = page.getByRole('dialog', { name: 'Set up new webhook', exact: true });
      await setup.click();
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Microsoft Teams webhook URL').fill(first.url);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(setup).toBeFocused();
      await setup.click();
      await expect(dialog.getByLabel('Microsoft Teams webhook URL')).toHaveValue('');
      await dialog.getByLabel('Microsoft Teams webhook URL').fill(first.url);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await setup.click();
      await expect(dialog.getByLabel('Microsoft Teams webhook URL')).toHaveValue('');
      await dialog.getByLabel('Microsoft Teams webhook URL').fill(first.url);
      await dialog.getByRole('button', { name: 'Save webhook', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.locator('#teams-connection-status')).toHaveText('Webhook configured');
      await expect(page.getByLabel('Milestone details changed', { exact: true })).toBeChecked();
      await expect(page.getByLabel('Milestone date changed', { exact: true })).not.toBeChecked();
      expect(await page.content()).not.toContain(first.url);
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'First connection' })).toBe(200);
      await deliverTeamsNotifications();
      expect(first.requests).toHaveLength(1);
      await setup.click();
      await dialog.getByLabel('Microsoft Teams webhook URL').fill(replacement.url);
      await dialog.getByRole('button', { name: 'Save webhook', exact: true }).click();
      await expect(page.locator('#teams-connection-status')).toHaveText('Webhook configured');
      await expect(dialog).not.toBeVisible();
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'Replacement connection' })).toBe(200);
      await deliverTeamsNotifications();
      expect(first.requests).toHaveLength(1);
      expect(replacement.requests).toHaveLength(1);
      await page.getByRole('button', { name: 'Disconnect webhook', exact: true }).click();
      await expect(page.locator('#teams-connection-status')).toHaveText('No webhook configured');
      await expect(page.getByLabel('Milestone details changed', { exact: true })).toBeChecked();
      await expect(page.getByLabel('Milestone date changed', { exact: true })).not.toBeChecked();
      await expect(page.getByRole('button', { name: 'Disconnect webhook', exact: true })).toHaveCount(0);
    } finally { await first.close(); await replacement.close(); }
  });

  test('Teams webhook dialog keeps validation errors visible without changing the saved connection', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      const milestoneId = await page.locator('.milestone').first().getAttribute('data-milestone-id');
      await configureTeams(page, webhook.url, ['milestone.updated']);
      await page.getByRole('button', { name: 'Set up new webhook', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Set up new webhook', exact: true });
      await dialog.locator('form').evaluate(form => { form.noValidate = true; });
      await dialog.getByRole('button', { name: 'Save webhook', exact: true }).click();
      await expect(dialog.locator('.errorlist')).toContainText('This field is required.');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Microsoft Teams webhook URL').fill('https://example.com/?sig=invalid-secret');
      await dialog.getByRole('button', { name: 'Save webhook', exact: true }).click();
      await expect(dialog.locator('.errorlist')).toContainText('Use an HTTPS Microsoft Teams or Power Automate webhook URL.');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Microsoft Teams webhook URL')).toHaveValue('');
      expect(await page.content()).not.toContain('invalid-secret');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.locator('#teams-connection-status')).toHaveText('Webhook configured');
      // Event preferences cannot implicitly replace or disconnect the webhook.
      expect(await postForm(page, '/workspaces/teams/', {
        action: 'workspace', teams_notify_events: 'milestone.updated',
        teams_webhook_url: 'https://example.com', disconnect: 'on',
      })).toBe(200);
      await page.goto('/workspaces/teams/');
      await expect(page.getByLabel('Milestone details changed', { exact: true })).toBeChecked();
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'Original connection retained' })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
    } finally { await webhook.close(); }
  });

  test('Teams webhook actions use clear German labels', async ({ appPage: page }) => {
    await page.goto('/workspaces/teams/');
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    await page.getByRole('button', { name: 'Neuen Webhook einrichten', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Neuen Webhook einrichten', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Microsoft-Teams-Webhook-URL').fill('https://test.logic.azure.com/workflows/test?sig=test-secret');
    await dialog.getByRole('button', { name: 'Webhook speichern', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#teams-connection-status')).toHaveText('Webhook eingerichtet');
    await page.getByRole('button', { name: 'Webhook trennen', exact: true }).click();
    await expect(page.locator('#teams-connection-status')).toHaveText('Kein Webhook eingerichtet');
    await expect(page.getByRole('button', { name: 'Neuen Webhook einrichten', exact: true })).toBeVisible();
  });

  test('Teams settings no longer import legacy project webhooks', async ({ appPage: page }) => {
    const projectId = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    // Simulate an existing installation with a retained project-level secret.
    await promisify(execFile)('uv', ['run', 'python', '-c', `
import os, sqlite3, sys
with sqlite3.connect(os.environ['DJANGO_DB_PATH']) as connection:
    connection.execute('UPDATE data_project SET teams_webhook_url = ? WHERE id = ?',
                       ('https://legacy.logic.azure.com/workflows/test?sig=legacy-test-secret', sys.argv[1]))
`, projectId], { cwd: path.resolve(__dirname, '../..'), env: djangoEnv() });
    await page.goto('/workspaces/teams/');
    expect(await postForm(page, '/workspaces/teams/', { action: 'workspace', legacy_project: projectId })).toBe(200);
    await page.reload();
    await expect(page.locator('#teams-connection-status')).toHaveText('No webhook configured');
    await expect(page.locator('[name=legacy_project]')).toHaveCount(0);
    await expect(page.getByText('Legacy project webhooks are no longer used.', { exact: false })).toHaveCount(0);
    await configureTeams(page, 'https://workspace.logic.azure.com/workflows/test?sig=workspace-test-secret');
    await expect(page.locator('#teams-connection-status')).toHaveText('Webhook configured');
  });

  test('workspace Teams webhook mentions roadmap followers for direct and task-driven changes', async ({ appPage: page, browser }) => {
    const webhook = await startWebhookServer();
    const visitorContext = await browser.newContext();
    try {
      await configureTeams(page, webhook.url);
      await saveTeamsIdentity(page, 'demo@example.com');
      const roadmap = await enableRoadmap(page);
      await page.goto('/');
      const milestone = page.locator('.milestone[data-title="v2 API beta"]').first();
      const milestoneId = await milestone.getAttribute('data-milestone-id');
      const taskId = await milestone.getAttribute('data-task-id');
      await page.goto(roadmap);
      const follow = page.locator('[data-project-subscription]', { hasText: 'API Migration' });
      await follow.getByRole('button', { name: 'Follow', exact: true }).click();
      await expect(follow.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      await page.reload();
      await expect(follow.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      await page.goto('/');
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'Subscribed milestone' })).toBe(200);
      expect(webhook.requests).toHaveLength(0); // Delivery never blocks the browser request.
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      const card = webhook.requests[0].json.attachments[0].content;
      expect(card.msteams.entities).toEqual([{
        type: 'mention', text: '<at>demo@example.com</at>',
        mentioned: { id: 'demo@example.com', name: 'demo@example.com' },
      }]);
      expect(card.body.at(-1)).toMatchObject({
        text: 'demo · <at>demo@example.com</at>', size: 'Small', wrap: true,
      });
      // The next delivery has both an authenticated and anonymous subscription
      // for the same address. It must still contain exactly one mention.
      const visitor = await visitorContext.newPage();
      await visitor.goto(roadmap);
      const anonymousFollow = visitor.locator('[data-project-subscription]', { hasText: 'API Migration' });
      await anonymousFollow.getByRole('button', { name: 'Follow', exact: true }).click();
      const dialog = visitor.getByRole('dialog', { name: 'Follow project', exact: true });
      await dialog.getByLabel('Teams email address', { exact: true }).fill('demo@example.com');
      await dialog.getByRole('button', { name: 'Follow', exact: true }).click();
      await expect(anonymousFollow.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
      await page.reload();
      const oldDate = await page.locator(`#ms-${milestoneId}`).getAttribute('data-date');
      const nextDate = new Date(`${oldDate}T00:00:00Z`);
      nextDate.setUTCDate(nextDate.getUTCDate() + 2);
      expect(await postForm(page, `/tasks/${taskId}/resize/end/`, { end: nextDate.toISOString().slice(0, 10) })).toBe(200);
      await page.reload();
      await expect(page.locator(`#ms-${milestoneId}`)).not.toHaveAttribute('data-date', oldDate);
      await deliverTeamsNotifications();
      const linkedChanges = webhook.requests.slice(1).filter(r => r.json.summary.includes('Subscribed milestone'));
      expect(linkedChanges).toHaveLength(1);
      expect(linkedChanges[0].json.attachments[0].content.msteams.entities.map(entity => entity.mentioned.id)).toEqual(['demo@example.com']);
      await unfollowProject(anonymousFollow);
      await expect(anonymousFollow.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
      await page.goto(roadmap);
      await unfollowProject(follow);
      await expect(follow.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
      await page.goto('/');
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'Unsubscribed milestone' })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests.at(-1).json.attachments[0].content.msteams).toBeUndefined();
      await page.goto('/activity/');
      await expect(page.locator('body')).not.toContainText(webhook.url);
    } finally { await visitorContext.close(); await webhook.close(); }
  });

  test('Teams subscriptions are self-service and scoped to roadmap workspace membership', async ({ appPage: page, browser }) => {
    const roadmap = await enableRoadmap(page);
    await page.goto(roadmap);
    const action = await page.locator('[data-project-subscription]', { hasText: 'API Migration' }).getAttribute('action');
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    try {
      await other.goto(roadmap);
      await expect(other.getByRole('link', { name: 'Sign in to follow projects' })).toHaveCount(0);
      await expect(other.locator('[data-project-subscription]')).toHaveCount(3);
      await other.goto('/accounts/login/');
      await other.locator('input[name=username]').fill('pm2');
      await other.locator('input[name=password]').fill('pm2');
      await other.locator('button[type=submit]').click();
      await other.waitForURL('/');
      // Non-members use the public flow and must supply a Teams address.
      expect(await postForm(other, action, { action: 'follow' })).toBe(400);
      await other.goto(roadmap);
      await expect(other.locator('[data-project-subscription]')).toHaveCount(3);
    } finally { await otherContext.close(); }

    await page.goto('/');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto('/accounts/login/');
    await page.locator('input[name=username]').fill('member1');
    await page.locator('input[name=password]').fill('member1');
    await page.locator('button[type=submit]').click();
    await page.waitForURL('/');
    expect((await page.goto('/workspaces/teams/')).status()).toBe(403);
    await page.goto('/profile/');
    expect(await postForm(page, '/workspaces/teams/', { teams_webhook_url: 'https://example.com', action: 'workspace' })).toBe(403);
    await saveTeamsIdentity(page, 'member@example.com');
    await page.goto(roadmap);
    await page.locator('[data-project-subscription]', { hasText: 'API Migration' }).getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(page.locator('[data-project-subscription]', { hasText: 'API Migration' }).getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
  });

  test('Teams creation notifications wait for a real milestone title and deletion notifies once', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await configureTeams(page, webhook.url, ['milestone.created', 'milestone.updated', 'milestone.deleted']);
      await page.goto('/');
      const project = page.locator('.project-group').filter({ hasText: 'API Migration' });
      await project.locator('.left-cell.proj').click();
      await page.locator('#pp-add-milestone').click();
      await placeMilestoneGhost(page, project);
      const id = await page.locator('#milestone-popover').getAttribute('data-milestone-id');
      await expect(page.locator('#milestone-popover input[name=title]')).toHaveValue('New milestone');
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(0);
      await page.locator('#milestone-popover input[name=title]').fill('New customer launch');
      await page.locator('#milestone-popover textarea[name=description]').fill('Customer launch readiness.');
      await page.locator('#milestone-popover button[type=submit]').click();
      await expect(page.locator('#milestone-popover')).toHaveCount(0);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      expect(webhook.requests[0].json.summary).toBe('API Migration · Meilenstein erstellt · New customer launch');
      expectTeamsLayout(webhook.requests[0].json.attachments[0].content,
        'API Migration', 'Meilenstein erstellt', 'New customer launch');
      expect(await postForm(page, `/milestones/${id}/update/`, { title: 'New customer launch' })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      expect(await postForm(page, `/milestones/${id}/delete/`, {})).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(2);
      expect(webhook.requests[1].json.summary).toBe('API Migration · Meilenstein gelöscht · New customer launch');
      expectTeamsLayout(webhook.requests[1].json.attachments[0].content,
        'API Migration', 'Meilenstein gelöscht', 'New customer launch');
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(2);
    } finally { await webhook.close(); }
  });

  test('Teams task deletion notifies the milestone subscribers', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await configureTeams(page, webhook.url, ['milestone.deleted']);
      await page.goto('/');
      const taskId = await page.locator('.milestone[data-title="v2 API beta"]').getAttribute('data-task-id');
      expect(await postForm(page, `/tasks/${taskId}/delete/`, {})).toBe(200);
      await page.reload();
      await expect(page.locator('.milestone[data-title="v2 API beta"]')).toHaveCount(0);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      expect(webhook.requests[0].json.summary).toBe('API Migration · Meilenstein gelöscht · v2 API beta');
    } finally { await webhook.close(); }
  });

  test('Teams project transfers send one message mentioning both projects followers', async ({ appPage: page, browser }) => {
    const webhook = await startWebhookServer();
    const memberContext = await browser.newContext();
    const member = await memberContext.newPage();
    try {
      await configureTeams(page, webhook.url, ['milestone.project_changed', 'milestone.updated']);
      await saveTeamsIdentity(page, 'demo@example.com');
      const roadmap = await enableRoadmap(page);
      await page.goto('/');
      const milestoneId = await page.locator('.milestone[data-title="v2 API beta"]').getAttribute('data-milestone-id');
      const taskId = await page.locator('.milestone[data-title="v2 API beta"]').getAttribute('data-task-id');
      const target = await page.locator('.left-cell.proj', { hasText: 'Onboarding revamp' }).getAttribute('data-project-id');
      await page.goto(roadmap);
      await page.locator('[data-project-subscription]', { hasText: 'API Migration' }).getByRole('button', { name: 'Follow', exact: true }).click();
      await page.locator('[data-project-subscription]', { hasText: 'Onboarding revamp' }).getByRole('button', { name: 'Follow', exact: true }).click();
      await member.goto('/accounts/login/');
      await member.locator('input[name=username]').fill('member1');
      await member.locator('input[name=password]').fill('member1');
      await member.locator('button[type=submit]').click();
      await member.waitForURL('/');
      await saveTeamsIdentity(member, 'member@example.com');
      await member.goto(roadmap);
      await member.locator('[data-project-subscription]', { hasText: 'Onboarding revamp' }).getByRole('button', { name: 'Follow', exact: true }).click();
      await page.goto('/');
      expect(await postForm(page, `/tasks/${taskId}/update/`, { project_id: target })).toBe(200);
      await page.reload();
      await expect(page.locator(`#ms-${milestoneId}`)).toHaveAttribute('data-project-id', target);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      const card = webhook.requests[0].json.attachments[0].content;
      expectTeamsLayout(card, 'Onboarding revamp', 'Projekt geändert', 'v2 API beta');
      expect(card.body[3].text).toContain('Projekt: API Migration → Onboarding revamp');
      expect(card.msteams.entities.map(entity => entity.mentioned.id)).toEqual(['demo@example.com', 'member@example.com']);
      // Same UPN on two subscriptions/users is mentioned only once.
      await saveTeamsIdentity(member, 'DEMO@example.com');
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'Shared follower' })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests.at(-1).json.attachments[0].content.msteams.entities).toHaveLength(1);
      await saveTeamsIdentity(member, '');
      await saveTeamsIdentity(page, '');
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'No identities' })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests.at(-1).json.attachments[0].content.msteams).toBeUndefined();
    } finally {
      await memberContext.close();
      await webhook.close();
    }
  });

  test('disconnecting the Teams webhook cancels pending delivery', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await configureTeams(page, webhook.url);
      await page.goto('/');
      const id = await page.locator('.milestone').first().getAttribute('data-milestone-id');
      expect(await postForm(page, `/milestones/${id}/update/`, { title: 'Never send this' })).toBe(200);
      await page.goto('/workspaces/teams/');
      await page.getByRole('button', { name: 'Disconnect webhook', exact: true }).click();
      await expect(page.locator('#teams-connection-status')).toHaveText('No webhook configured');
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(0);
      await page.reload();
      await expect(page.locator('#teams-connection-status')).toHaveText('No webhook configured');
      await expect(page.locator('#teams-deliveries')).toContainText('Cancelled');
    } finally { await webhook.close(); }
  });

  for (const lockStage of ['before delivery', 'after HTTP acceptance']) {
    test(`Teams worker survives SQLite contention ${lockStage} without resending`, async ({ appPage: page }) => {
      let lock;
      const webhook = await startWebhookServer([200], async () => {
        if (lockStage === 'after HTTP acceptance' && !lock) lock = await holdSQLiteWriteLock();
      });
      try {
        await configureTeams(page, webhook.url);
        await page.goto('/');
        const id = await page.locator('.milestone').first().getAttribute('data-milestone-id');
        expect(await postForm(page, `/milestones/${id}/update/`, { title: 'Concurrent SQLite writer' })).toBe(200);
        await ageNotificationBatches();
        if (lockStage === 'before delivery') lock = await holdSQLiteWriteLock();
        const result = await deliverTeamsNotifications({ advance: false }).then(
          () => ({ code: 0 }), error => ({ code: error.code, stderr: error.stderr }),
        );
        expect(result.code, result.stderr).toBe(0);
        expect(webhook.errors).toEqual([]);
        expect(webhook.requests).toHaveLength(1);
        await deliverTeamsNotifications();
        expect(webhook.requests).toHaveLength(1);
        await page.goto('/workspaces/teams/');
        await expect(page.locator('#teams-deliveries')).toContainText('Sent (1)');
      } finally {
        if (lock) await lock.done;
        await webhook.close();
      }
    });
  }

  test('Teams delivery persists and retries throttled requests without duplicate successful sends', async ({ appPage: page }) => {
    const webhook = await startWebhookServer([429, 200]);
    try {
      await configureTeams(page, webhook.url);
      await page.goto('/');
      const id = await page.locator('.milestone').first().getAttribute('data-milestone-id');
      expect(await postForm(page, `/milestones/${id}/update/`, { title: 'Retry notification' })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      await page.goto('/workspaces/teams/');
      await expect(page.locator('#teams-deliveries')).toContainText('Pending');
      await expect.poll(async () => {
        await deliverTeamsNotifications();
        return webhook.requests.length;
      }, { intervals: [1100], timeout: 10000 }).toBe(2);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(2);
      expect(webhook.requests[0].json).toEqual(webhook.requests[1].json);
      await page.reload();
      await expect(page.locator('#teams-deliveries')).toContainText('Sent');
    } finally { await webhook.close(); }
  });
});

// =============================================================================
// Auth + first render
// =============================================================================
test.describe('auth + page render', () => {
  test('session survives another localhost app replacing the default session cookie', async ({ appPage: page }) => {
    // Cookies are shared across ports: simulate another Django app on 8111.
    await page.context().addCookies([{
      name: 'sessionid', value: 'another-django-app-session',
      url: 'http://localhost:8111', httpOnly: true, sameSite: 'Lax',
    }]);
    await page.reload();
    await expect(page).toHaveURL('/');
    await expect(page.locator('#grid-scroll')).toBeVisible();
    await expect(page.locator('.sidebar-user .user-name')).toHaveText('demo');
    const cookies = await page.context().cookies();
    expect(cookies.find(cookie => cookie.name === 'nano_pm_sessionid')?.httpOnly).toBe(true);
    expect(cookies.find(cookie => cookie.name === 'sessionid')?.value).toBe('another-django-app-session');
  });

  test('login form renders readable labeled daisyUI fields', async ({ page, request }) => {
    await reset(request);
    await page.goto('/accounts/login/');
    await expect(page.locator('.login-card fieldset.fieldset')).toHaveClass(/\bbg-base-200\b/);
    await expect(page.locator('.login-card .fieldset-legend')).toHaveText('Login');
    await expect(page.locator('.login-card label.label')).toHaveText(['Username', 'Password']);
    for (const name of ['username', 'password']) {
      const input = page.locator(`input[name=${name}]`);
      await expect(input).toBeVisible();
      await expect(input).toHaveCSS('font-size', '16px');
      await expect(input).toHaveClass(/\binput\b/);
    }
  });

  test('an unauthenticated request to / redirects to login', async ({ page, request }) => {
    await reset(request);
    const r = await page.goto('/');
    expect(r.url()).toContain('/accounts/login/');
  });

  test('demo / demo logs in and lands on the chart', async ({ page, request }) => {
    await reset(request);
    await loginThroughUI(page);
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

    await page.getByRole('button', { name: 'Remove Sam Patel' }).click();
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('#task-popover')).toHaveCount(0);

    await page.getByRole('link', { name: 'Activity' }).click();
    const event = page.locator('.activity-event').first();
    await expect(event).toContainText('Assignees');
    await expect(event).toContainText('Alex Chen, Sam Patel → Alex Chen');
    await expect(event).not.toContainText("['Alex Chen', 'Sam Patel']");
  });

  test('activity events are paginated with newest events first', async ({ appPage: page }) => {
    const taskId = await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).getAttribute('data-task-id');

    const statuses = await page.evaluate(async ({ taskId }) => {
      const token = document.cookie.split('; ').find((row) => row.startsWith('csrftoken='))?.split('=')[1] || '';
      const results = [];
      for (let number = 1; number <= 26; number += 1) {
        const response = await fetch(`/tasks/${taskId}/update/`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-CSRFToken': decodeURIComponent(token), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ title: `Pagination event ${String(number).padStart(2, '0')}` }),
        });
        results.push(response.status);
        await response.text();
      }
      return results;
    }, { taskId });
    expect(statuses).toEqual(Array(26).fill(200));

    await page.goto('/activity/');
    await expect(page.locator('.activity-event')).toHaveCount(25);
    await expect(page.locator('.activity-event').first()).toContainText('Pagination event 26');

    const pagination = page.getByRole('navigation', { name: 'Activity pagination' });
    await expect(pagination.locator('.join')).toBeVisible();
    await expect(pagination.locator('[aria-current=page]')).toHaveText('1');
    await expect(pagination.locator('[aria-current=page]')).toHaveClass(/\bbtn-active\b/);
    await expect(pagination.getByRole('link', { name: '2', exact: true })).toHaveAttribute('href', '/activity/?page=2');

    await pagination.getByRole('link', { name: 'Next' }).click();
    await expect(page).toHaveURL('/activity/?page=2');
    await expect(page.locator('.activity-event')).toHaveCount(1);
    await expect(page.locator('.activity-event').first()).toContainText('Pagination event 01');
    await expect(pagination.locator('[aria-current=page]')).toHaveText('2');
    await expect(pagination.getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '/activity/?page=1');
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
    const event = page.locator('.activity-event[data-action="task.resized"]').first();
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

  test('warns unfinished projects without a future milestone', async ({ appPage: page }) => {
    const warnings = page.locator('.future-milestone-warning');
    await expect(warnings).toHaveCount(1);
    await expect(page.locator('.left-cell.proj', { hasText: 'Infra hardening' }).locator('.future-milestone-warning')).toBeVisible();
    await expect(warnings).toHaveAttribute('aria-label', 'No future milestone');

    // Finished projects do not need a future milestone and must not be warned.
    await page.locator('.left-cell.proj', { hasText: 'Infra hardening' }).click();
    await page.waitForSelector('#project-popover');
    await page.click('#pp-toggle-complete');
    await page.click('#show-completed-toggle');
    await expect(page.locator('.left-cell.proj.completed', { hasText: 'Infra hardening' }).locator('.future-milestone-warning')).toHaveCount(0);
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

  test('team filter includes entire projects owned by people on the selected team', async ({ appPage: page }) => {
    const apiProject = page.locator('.project-group').filter({ hasText: 'API Migration' });
    await apiProject.locator('.left-cell.proj').click();
    const responsible = page.locator('#project-responsible-people');
    const rileyValue = await responsible.locator('option', { hasText: 'Riley Wong' }).getAttribute('value');
    await responsible.selectOption(rileyValue);
    await page.click('#project-popover button[type=submit]');
    await expect(page.locator('#project-popover')).toHaveCount(0);

    await page.locator('#team-filter summary').click();
    await page.locator('#team-filter .team-filter-option', { hasText: 'Design' }).click();

    // The task count only changes after the server-rendered chart patch lands.
    await expect(page.locator('.left-cell.task:visible')).toHaveCount(7);
    await expect(page.locator('.left-cell.proj')).toHaveCount(3);
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toBeVisible();
    await expect(apiProject.locator('.left-cell.task:visible')).toHaveCount(3);
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
// Task detail
// =============================================================================
test.describe('detail page alignment', () => {
  for (const kind of ['project', 'task']) {
    test(`${kind} detail uses the same left alignment as Ideas`, async ({ appPage: page }) => {
      const row = kind === 'task'
        ? page.locator('.bar', { hasText: 'Migrate /users endpoints' })
        : page.locator('.left-cell.proj', { hasText: 'API Migration' });
      const id = await row.getAttribute(`data-${kind}-id`);
      // A wide desktop exposes automatic centering beyond the content max-width.
      for (const width of [1920, 720, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/ideas/');
        const reference = await page.locator('#ideas-page').evaluate(el => {
          const rect = el.getBoundingClientRect();
          return { x: rect.x, contentX: rect.x + parseFloat(getComputedStyle(el).paddingLeft) };
        });
        await page.goto(`/${kind}s/${id}/`);
        const detail = page.locator(`#${kind}-detail-page`);
        await expect(detail).toBeVisible();
        const bounds = await detail.boundingBox();
        const section = await detail.locator('section').first().boundingBox();
        expect(bounds.x).toBeCloseTo(reference.x, 0);
        expect(section.x).toBeCloseTo(reference.contentX, 0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
    });
  }
});

test.describe('detail editor checkbox layout', () => {
  for (const kind of ['task', 'project']) {
    test(`${kind} detail checkboxes align with their labels without a fake checkbox container`, async ({ appPage: page }) => {
      const row = kind === 'task'
        ? page.locator('.bar', { hasText: 'Migrate /users endpoints' })
        : page.locator('.left-cell.proj', { hasText: 'API Migration' });
      const id = await row.getAttribute(`data-${kind}-id`);
      await page.goto(`/${kind}s/${id}/`);
      await page.getByText(`Edit ${kind}`, { exact: true }).click();
      const editor = page.locator(`#${kind}-detail-editor`);
      const group = editor.getByRole('group', { name: kind === 'task' ? 'Assignees' : 'Responsible people', exact: true });
      // Django's default widget repeats attrs.class on its outer div as well
      // as the inputs. DaisyUI must style only real checkbox inputs.
      await expect(group.locator('.checkbox:not(input)')).toHaveCount(0);
      await expect(group.getByRole('checkbox')).toHaveCount(3);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const label of await group.locator('label').all()) {
          const input = await label.getByRole('checkbox').boundingBox();
          const text = await label.locator('span').boundingBox();
          const bounds = await group.boundingBox();
          expect(text.x).toBeGreaterThanOrEqual(input.x + input.width + 4);
          expect(Math.abs((input.y + input.height / 2) - (text.y + text.height / 2))).toBeLessThan(2);
          expect(input.y + input.height).toBeLessThanOrEqual(bounds.y + bounds.height);
          expect(text.x + text.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        }
      }
      const alex = group.getByRole('checkbox', { name: 'Alex Chen', exact: true });
      const initiallyChecked = await alex.isChecked();
      await group.getByText('Alex Chen', { exact: true }).click();
      await expect(alex).toBeChecked({ checked: !initiallyChecked });
      await editor.getByRole('button', { name: `Save ${kind}`, exact: true }).click();
      await page.reload();
      await page.getByText(`Edit ${kind}`, { exact: true }).click();
      await expect(alex).toBeChecked({ checked: !initiallyChecked });
    });
  }
});


test.describe('task detail editing', () => {
  test('task detail saves edits in place and cascades dates to dependent tasks and milestones', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const id = await bar.getAttribute('data-task-id');
    const end = await bar.getAttribute('data-end');
    const successor = page.locator('.bar', { hasText: 'Cutover and deprecation' });
    const successorId = await successor.getAttribute('data-task-id');
    const successorEnd = await successor.getAttribute('data-end');
    const shift = date => new Date(new Date(`${date}T00:00:00Z`).getTime() + 4 * 86400000).toISOString().slice(0, 10);
    await page.goto(`/tasks/${id}/`);
    await page.getByText('Edit task', { exact: true }).click();
    const editor = page.locator('#task-detail-editor');
    await editor.getByLabel('Title', { exact: true }).fill('Migrate users from the detail page');
    await editor.getByLabel('Description', { exact: true }).fill('Verify permissions and migrate public traffic.');
    await editor.getByLabel('End (exclusive)', { exact: true }).fill(shift(end));
    await editor.getByLabel('Sam Patel', { exact: true }).uncheck();
    await editor.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page).toHaveURL(`/tasks/${id}/`);
    await expect(page.locator('#task-detail-page h1')).toHaveText('Migrate users from the detail page');
    await expect(page.getByRole('status')).toHaveText('Task saved.');
    await expect(page.locator('#task-detail-description')).toHaveText('Verify permissions and migrate public traffic.');
    await expect(page.locator('[data-task-end]')).toHaveAttribute('datetime', shift(end));
    await expect(page.getByRole('region', { name: 'Task overview' })).not.toContainText('Sam Patel');
    await page.reload();
    await expect(page.locator('#task-detail-page h1')).toHaveText('Migrate users from the detail page');
    await page.goto(`/tasks/${successorId}/`);
    await expect(page.locator('[data-task-start]')).toHaveAttribute('datetime', shift(end));
    await expect(page.locator('[data-task-end]')).toHaveAttribute('datetime', shift(successorEnd));
    await expect(page.locator('[data-milestone-id] time')).toHaveAttribute('datetime', shift(successorEnd));
    await page.goto('/');
    await expect(page.locator(`#bar-${id}`)).toHaveAttribute('data-end', shift(end));
    await expect(page.locator(`#bar-${id}`)).toContainText('Migrate users from the detail page');
  });

  test('task detail can move projects and connect and disconnect milestones', async ({ appPage: page }) => {
    const id = await page.locator('.bar', { hasText: 'Audit IAM policies' }).getAttribute('data-task-id');
    const projectId = await page.locator('.left-cell.proj', { hasText: 'Onboarding revamp' }).getAttribute('data-project-id');
    const date = await page.locator('.bar', { hasText: 'Audit IAM policies' }).getAttribute('data-end');
    expect(await postForm(page, `/projects/${projectId}/milestones/`, { date })).toBe(200);
    await page.goto(`/tasks/${id}/`);
    await page.getByText('Edit task', { exact: true }).click();
    const editor = page.locator('#task-detail-editor');
    await editor.getByLabel('Project', { exact: true }).selectOption(projectId);
    const milestone = await editor.getByLabel('Milestone', { exact: true }).locator('option', { hasText: 'New milestone' }).getAttribute('value');
    await editor.getByLabel('Milestone', { exact: true }).selectOption(milestone);
    await editor.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.locator('#task-detail-page > header')).toContainText('Onboarding revamp');
    await expect(page.locator('[data-milestone-id]')).toHaveAttribute('data-milestone-id', milestone);
    await expect(page.locator('[data-milestone-id] time')).toHaveAttribute('datetime', date);
    await page.getByText('Edit task', { exact: true }).click();
    await editor.getByLabel('Milestone', { exact: true }).selectOption('');
    await editor.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.locator('#task-detail-page')).toContainText('No milestone');
    await page.goto(`/projects/${projectId}/`);
    await expect(page.locator('[data-milestone-id]')).toHaveCount(2);
    await expect(page.getByRole('link', { name: 'Audit IAM policies', exact: true })).toBeVisible();
  });

  test('task detail validates milestone connections and preserves linked milestones when moving projects', async ({ appPage: page }) => {
    const id = await page.locator('.bar', { hasText: 'Audit IAM policies' }).getAttribute('data-task-id');
    const projectId = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    const infraId = await page.locator('.left-cell.proj', { hasText: 'Infra hardening' }).getAttribute('data-project-id');
    const start = await page.locator(`#bar-${id}`).getAttribute('data-start');
    const end = await page.locator(`#bar-${id}`).getAttribute('data-end');
    const linkedTask = await page.locator('.bar', { hasText: 'Cutover and deprecation' }).getAttribute('data-task-id');
    const linkedMilestone = await page.locator('.milestone[data-title="v2 API beta"]').getAttribute('data-milestone-id');
    expect(await postForm(page, `/projects/${projectId}/milestones/`, { date: end })).toBe(200);
    await page.goto(`/tasks/${id}/`);
    await page.getByText('Edit task', { exact: true }).click();
    const editor = page.locator('#task-detail-editor');
    await editor.getByLabel('Milestone', { exact: true }).selectOption({ label: 'API Migration — New milestone' });
    await editor.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('Choose a milestone from the selected project.');
    await expect(page.locator('#task-detail-page [data-milestone-id]')).toHaveCount(0);
    expect(await postForm(page, `/tasks/${id}/`, { title: 'Steal linked milestone', description: '', start, end, project_id: infraId, milestone_id: linkedMilestone })).toBe(400);
    await page.goto(`/tasks/${linkedTask}/`);
    await page.getByText('Edit task', { exact: true }).click();
    await editor.getByLabel('Project', { exact: true }).selectOption(infraId);
    await editor.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.locator('#task-detail-page > header')).toContainText('Infra hardening');
    await expect(page.locator('#task-detail-page [data-milestone-id]')).toHaveAttribute('data-milestone-id', linkedMilestone);
    await page.goto(`/projects/${infraId}/`);
    await expect(page.locator(`[data-milestone-id="${linkedMilestone}"]`)).toContainText('v2 API beta');
  });

  test('task detail invalid edits retain input and leave committed state unchanged', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const id = await bar.getAttribute('data-task-id');
    const start = await bar.getAttribute('data-start');
    const end = await bar.getAttribute('data-end');
    await page.goto(`/tasks/${id}/`);
    await page.getByText('Edit task', { exact: true }).click();
    const editor = page.locator('#task-detail-editor');
    await editor.getByLabel('Title', { exact: true }).fill('Unsaved invalid edit');
    await editor.getByLabel('End (exclusive)', { exact: true }).fill(start);
    await editor.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(editor).toHaveAttribute('open', '');
    await expect(editor.getByRole('alert')).toContainText('End must be after start.');
    await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('Unsaved invalid edit');
    await expect(page.locator('#task-detail-page h1')).toHaveText('Migrate /users endpoints');
    await expect(page.locator('[data-task-end]')).toHaveAttribute('datetime', end);
    await page.goto(`/tasks/${id}/`);
    await expect(page.locator('#task-detail-page h1')).toHaveText('Migrate /users endpoints');
  });

  test('task detail cancel discards edits without changing the task', async ({ appPage: page }) => {
    const id = await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).getAttribute('data-task-id');
    await page.goto(`/tasks/${id}/`);
    await page.getByText('Edit task', { exact: true }).click();
    const editor = page.locator('#task-detail-editor');
    await editor.getByLabel('Title', { exact: true }).fill('Discard me');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).not.toHaveAttribute('open', '');
    await page.getByText('Edit task', { exact: true }).click();
    await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('Migrate /users endpoints');
    await page.reload();
    await expect(page.locator('#task-detail-page h1')).toHaveText('Migrate /users endpoints');
  });

  test('detail editing enforces member permissions on the server', async ({ appPage: page }) => {
    const assignedId = await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).getAttribute('data-task-id');
    const otherId = await page.locator('.bar', { hasText: 'User research interviews' }).getAttribute('data-task-id');
    const projectId = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.fill('input[name=username]', 'member1');
    await page.fill('input[name=password]', 'member1');
    await page.click('button[type=submit]');
    await page.waitForURL('/');
    await page.goto(`/tasks/${assignedId}/`);
    await page.getByText('Edit task', { exact: true }).click();
    const editor = page.locator('#task-detail-editor');
    await editor.getByLabel('Title', { exact: true }).fill('Updated by assigned member');
    await editor.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.locator('#task-detail-page h1')).toHaveText('Updated by assigned member');
    await page.goto(`/tasks/${otherId}/`);
    await expect(page.locator('#task-detail-editor')).toHaveCount(0);
    expect(await postForm(page, `/tasks/${otherId}/`, { title: 'Forbidden task edit' })).toBe(403);
    await page.reload();
    await expect(page.locator('#task-detail-page h1')).toHaveText('User research interviews');
    await page.goto(`/projects/${projectId}/`);
    await expect(page.locator('#project-detail-editor')).toHaveCount(0);
    expect(await postForm(page, `/projects/${projectId}/`, { name: 'Forbidden project edit' })).toBe(403);
    await page.reload();
    await expect(page.locator('#project-detail-page h1')).toHaveText('API Migration');
  });

  test('detail editing rejects cross-workspace relations and stale workspace submissions', async ({ appPage: page }) => {
    const id = await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).getAttribute('data-task-id');
    const projectId = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    const start = await page.locator(`#bar-${id}`).getAttribute('data-start');
    const end = await page.locator(`#bar-${id}`).getAttribute('data-end');
    const sourceWorkspace = await page.locator('#workspace-menu form[action$="/switch/"]').first().getAttribute('action');
    await postForm(page, '/workspaces/', { name: 'Foreign edit workspace' });
    await page.goto('/');
    await page.locator('.left-cell.add-project-row').first().click();
    await expect(page.locator('.left-cell.proj')).toHaveCount(1);
    const foreignId = await page.locator('.left-cell.proj').getAttribute('data-project-id');
    expect(await postForm(page, `/tasks/${id}/`, { title: 'Wrong workspace' })).toBe(404);
    expect(await postForm(page, `/projects/${projectId}/`, { name: 'Wrong workspace' })).toBe(404);
    await postForm(page, sourceWorkspace, {});
    await page.goto(`/tasks/${id}/`);
    expect(await postForm(page, `/tasks/${id}/`, { title: 'Foreign project edit', description: '', start, end, project_id: foreignId })).toBe(400);
    expect(await postForm(page, `/tasks/${id}/`, { title: 'Foreign person edit', description: '', start, end, project_id: projectId, assignee_ids: '999999' })).toBe(400);
    await page.reload();
    await expect(page.locator('#task-detail-page h1')).toHaveText('Migrate /users endpoints');
    await expect(page.locator('#task-detail-page')).toContainText('Sam Patel');
    await page.goto(`/projects/${projectId}/`);
    expect(await postForm(page, `/projects/${projectId}/`, { name: 'Invalid project edit', description: '', color: '#3b82f6', responsible_person_ids: '999999' })).toBe(400);
    expect(await postForm(page, `/projects/${projectId}/`, { name: 'Invalid color', description: '', color: 'red; background:url(evil)' })).toBe(400);
    await page.reload();
    await expect(page.locator('#project-detail-page h1')).toHaveText('API Migration');
  });
});


test.describe('project detail editing', () => {
  test('project detail saves name description color and responsible people in place', async ({ appPage: page }) => {
    const id = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    await page.goto(`/projects/${id}/`);
    await page.getByText('Edit project', { exact: true }).click();
    const editor = page.locator('#project-detail-editor');
    await editor.getByLabel('Name', { exact: true }).fill('API v2 rollout');
    await editor.getByLabel('Description', { exact: true }).fill('Ship v2 safely.\nKeep migration notes here.');
    await editor.getByLabel('Color', { exact: true }).selectOption('#10b981');
    await editor.getByLabel('Alex Chen', { exact: true }).check();
    await editor.getByLabel('Sam Patel', { exact: true }).check();
    await editor.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(page).toHaveURL(`/projects/${id}/`);
    await expect(page.locator('#project-detail-page h1')).toHaveText('API v2 rollout');
    await expect(page.getByRole('status')).toHaveText('Project saved.');
    await expect(page.locator('#project-detail-page > header .swatch')).toHaveCSS('background-color', 'rgb(16, 185, 129)');
    await expect(page.locator('#project-detail-page')).toContainText('Ship v2 safely.');
    const responsible = page.getByRole('region', { name: 'Project overview' });
    await expect(responsible).toContainText('Alex Chen');
    await expect(responsible).toContainText('Sam Patel');
    await page.reload();
    await page.getByText('Edit project', { exact: true }).click();
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('API v2 rollout');
    await expect(editor.getByLabel('Alex Chen', { exact: true })).toBeChecked();
    await editor.getByLabel('Alex Chen', { exact: true }).uncheck();
    await editor.getByLabel('Sam Patel', { exact: true }).uncheck();
    await editor.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(responsible).toContainText('Nobody assigned');
    await page.goto('/');
    await expect(page.locator(`#proj-${id} .name`)).toHaveText('API v2 rollout');
  });

  test('project detail validates required names and supports cancelling edits', async ({ appPage: page }) => {
    const id = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    await page.goto(`/projects/${id}/`);
    await page.getByText('Edit project', { exact: true }).click();
    const editor = page.locator('#project-detail-editor');
    await editor.getByLabel('Name', { exact: true }).fill('   ');
    await editor.getByLabel('Description', { exact: true }).fill('Do not commit this.');
    await editor.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('This field is required.');
    await expect(editor.getByLabel('Description', { exact: true })).toHaveValue('Do not commit this.');
    await expect(page.locator('#project-detail-page h1')).toHaveText('API Migration');
    await page.goto(`/projects/${id}/`);
    await page.getByText('Edit project', { exact: true }).click();
    await editor.getByLabel('Name', { exact: true }).fill('Discard project change');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).not.toHaveAttribute('open', '');
    await page.getByText('Edit project', { exact: true }).click();
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('API Migration');
  });

  test('project responsible members can edit project details and unassigned-to-them tasks', async ({ appPage: page }) => {
    const projectId = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    const taskId = await page.locator('.bar', { hasText: 'Cutover and deprecation' }).getAttribute('data-task-id');
    await page.goto(`/projects/${projectId}/`);
    await page.getByText('Edit project', { exact: true }).click();
    await page.locator('#project-detail-editor').getByLabel('Alex Chen', { exact: true }).check();
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.fill('input[name=username]', 'member1');
    await page.fill('input[name=password]', 'member1');
    await page.click('button[type=submit]');
    await page.waitForURL('/');
    await page.goto(`/projects/${projectId}/`);
    await page.getByText('Edit project', { exact: true }).click();
    await page.locator('#project-detail-editor').getByLabel('Description', { exact: true }).fill('Managed by Alex.');
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(page.locator('#project-detail-page')).toContainText('Managed by Alex.');
    await page.goto(`/tasks/${taskId}/`);
    await page.getByText('Edit task', { exact: true }).click();
    await page.locator('#task-detail-editor').getByLabel('Title', { exact: true }).fill('Cutover managed by Alex');
    await page.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.locator('#task-detail-page h1')).toHaveText('Cutover managed by Alex');
  });
});


test.describe('task detail', () => {
  test('task detail opens from the hover-only sidebar maximize link', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const start = await bar.getAttribute('data-start');
    const end = await bar.getAttribute('data-end');
    await bar.click();
    const sidebar = page.locator('#task-popover');
    await expect(sidebar).toBeVisible();
    const link = sidebar.getByRole('link', { name: 'Open task details' });
    await page.mouse.move(700, 20);
    await expect(link).toHaveCSS('opacity', '0');
    await sidebar.hover();
    await expect(link).toHaveCSS('opacity', '1');
    await link.focus();
    await page.mouse.move(700, 20);
    await expect(link).toHaveCSS('opacity', '1');
    await link.press('Enter');
    await expect(page).toHaveURL(/\/tasks\/\d+\/$/);
    const detail = page.locator('#task-detail-page');
    await expect(detail.getByRole('heading', { name: 'Migrate /users endpoints', exact: true })).toBeVisible();
    await expect(detail.locator('[data-status]')).toHaveAttribute('data-status', 'in-progress');
    await expect(detail.locator('[data-task-start]')).toHaveAttribute('datetime', start);
    await expect(detail.locator('[data-task-end]')).toHaveAttribute('datetime', end);
    await expect(detail).toContainText('Alex Chen');
    await expect(detail).toContainText('Sam Patel');
    await expect(detail).toContainText('No milestone');
    await expect(detail.getByRole('link', { name: 'Spike on auth changes', exact: true })).toBeVisible();
    await expect(detail.getByRole('link', { name: 'Cutover and deprecation', exact: true })).toBeVisible();
    await page.reload();
    await expect(detail.getByRole('heading', { name: 'Migrate /users endpoints', exact: true })).toBeVisible();
  });

  test('task detail links from project tasks show linked milestones and related tasks', async ({ appPage: page }) => {
    const projectId = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    await page.goto(`/projects/${projectId}/`);
    await page.getByRole('link', { name: 'Cutover and deprecation', exact: true }).click();
    const detail = page.locator('#task-detail-page');
    await expect(detail.getByRole('heading', { name: 'Cutover and deprecation', exact: true })).toBeVisible();
    await expect(detail.locator('[data-status]')).toHaveAttribute('data-status', 'planned');
    await expect(detail).toContainText('v2 API beta');
    await expect(detail).toContainText('v2 API beta readiness checkpoint.');
    await detail.getByRole('link', { name: 'Migrate /users endpoints', exact: true }).click();
    await detail.getByRole('link', { name: 'Spike on auth changes', exact: true }).click();
    await expect(detail.locator('[data-status]')).toHaveAttribute('data-status', 'done');
    // Cross-project dependencies stay navigable within the same workspace.
    await detail.getByRole('link', { name: 'Tutorial flow v2', exact: true }).click();
    await expect(detail.getByRole('heading', { name: 'Tutorial flow v2', exact: true })).toBeVisible();
    await detail.getByRole('link', { name: 'Back to project', exact: true }).click();
    await expect(page.locator('#project-detail-page h1')).toHaveText('Onboarding revamp');
  });

  test('task detail hover links work from project and resource timeline lists', async ({ appPage: page }) => {
    const row = page.locator('.left-cell.task', { hasText: 'Migrate /users endpoints' });
    const id = await row.getAttribute('data-task-id');
    const link = row.getByRole('link', { name: 'Open task details' });
    await page.mouse.move(700, 20);
    await expect(link).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(link).toHaveCSS('opacity', '1');
    await link.click();
    await expect(page).toHaveURL(`/tasks/${id}/`);
    await page.goto('/resources/');
    const resourceRow = page.locator(`.left-cell.task[data-task-id="${id}"]`).first();
    await resourceRow.hover();
    await resourceRow.getByRole('link', { name: 'Open task details' }).click();
    await expect(page).toHaveURL(`/tasks/${id}/`);
  });

  test('task detail shows saved descriptions safely and fits mobile screens', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const id = await bar.getAttribute('data-task-id');
    const description = 'Check permissions before cutover.\n<img src=x onerror=alert(1)>';
    await bar.click();
    await page.locator('#task-description').fill(description);
    await page.locator('#task-popover button[type=submit]').click();
    await expect(page.locator('#task-popover')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/tasks/${id}/`);
    await expect(page.locator('#task-detail-description')).toHaveText(description);
    await expect(page.locator('#task-detail-description img')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('task detail is available to workspace members and translated in German', async ({ appPage: page }) => {
    const id = await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).getAttribute('data-task-id');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.fill('input[name=username]', 'member1');
    await page.fill('input[name=password]', 'member1');
    await page.click('button[type=submit]');
    await page.waitForURL('/');
    await page.goto(`/tasks/${id}/`);
    await expect(page.locator('#task-detail-page h1')).toHaveText('Migrate /users endpoints');
    await page.getByRole('button', { name: 'DE', exact: true }).click();
    const detail = page.locator('#task-detail-page');
    await expect(detail.getByRole('heading', { name: 'Beschreibung', exact: true })).toBeVisible();
    await expect(detail.locator('[data-status]')).toHaveText('In Bearbeitung');
    await expect(detail).toContainText('Dauer');
    await expect(detail).toContainText('12 Tage');
    await expect(detail.getByRole('link', { name: 'Zurück zum Projekt', exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: 'Hängt ab von', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('Aufgabe bearbeiten', { exact: true }).click();
    await page.locator('#task-detail-editor').getByLabel('Titel', { exact: true }).fill('Von Alex aktualisiert');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole('button', { name: 'Aufgabe speichern', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Aufgabe gespeichert.');
    await expect(detail.locator('h1')).toHaveText('Von Alex aktualisiert');
  });

  test('task detail handles unassigned tasks and enforces workspace and login boundaries', async ({ appPage: page, browser }) => {
    const projectId = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    const start = await page.locator('.bar').first().getAttribute('data-start');
    const end = await page.locator('.bar').first().getAttribute('data-end');
    expect(await postForm(page, '/tasks/create/', { project_id: projectId, start, end, title: 'Unassigned detail task' })).toBe(200);
    await page.reload();
    const id = await page.locator('.left-cell.task', { hasText: 'Unassigned detail task' }).getAttribute('data-task-id');
    await page.goto(`/tasks/${id}/`);
    const detail = page.locator('#task-detail-page');
    await expect(detail).toContainText('Nobody assigned');
    await expect(detail).toContainText('No description yet.');
    await expect(detail).toContainText('No milestone');
    await expect(detail).toContainText('No dependencies.');
    const anonymous = await browser.newContext();
    try {
      const response = await anonymous.request.get(new URL(`/tasks/${id}/`, page.url()).href, { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(response.headers().location).toContain('/accounts/login/');
    } finally {
      await anonymous.close();
    }
    expect((await page.goto('/tasks/999999/')).status()).toBe(404);
    await page.goto('/');
    await postForm(page, '/workspaces/', { name: 'Task detail other workspace' });
    expect((await page.goto(`/tasks/${id}/`)).status()).toBe(404);
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
    await expect(page.locator('#task-popover input[name=milestone_title]')).toHaveCount(0);
    await expect(page.locator('#task-popover select[name=milestone_id]')).toHaveClass(/\bselect\b/);
    await expect(page.locator('#task-popover select[name=project_id]')).toHaveClass(/\bselect\b/);
  });

  test('task assignees are shown as removable pills', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    await bar.click();
    const assignees = page.locator('#task-assignees');
    const pills = page.locator('#task-assignee-pills .task-assignee-pill:visible');
    await expect(assignees).toBeVisible();
    await expect(pills).toHaveCount(2);
    await expect(pills).toContainText(['Alex Chen', 'Sam Patel']);

    const removeSam = page.getByRole('button', { name: 'Remove Sam Patel' });
    await expect(removeSam.locator('svg')).toHaveCount(1);
    await removeSam.click();
    await expect(pills).toHaveCount(1);

    const samValue = await assignees.locator('option', { hasText: 'Sam Patel' }).getAttribute('value');
    await assignees.selectOption(samValue);
    await expect(pills).toHaveCount(2);
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
  test('milestone creation sidebar lists proposed task connections', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const taskId = await bar.getAttribute('data-task-id');
    const taskEnd = await bar.getAttribute('data-end');
    const project = page.locator('.project-group').filter({ has: bar });
    const projectRow = project.locator('.chart-row.proj');
    const projectRowBox = await projectRow.boundingBox();
    const barBox = await bar.boundingBox();

    await project.getByRole('button', { name: 'Add milestone' }).click();
    await page.mouse.click(barBox.x + barBox.width, projectRowBox.y + projectRowBox.height / 2);

    await expect(page.locator('#milestone-task-link-dialog')).toHaveCount(0);
    const editor = page.locator('#milestone-popover');
    await expect(editor).toBeVisible();
    const proposals = editor.locator('#milestone-task-proposals');
    const proposal = proposals.locator(`[data-task-id="${taskId}"]`);
    await expect(proposal).toContainText('Migrate /users endpoints');
    const connect = proposal.locator('button');
    await expect(connect).toHaveText('Connect');
    await expect(connect).toHaveAttribute('aria-pressed', 'false');
    await connect.click();
    await expect(connect).toHaveAttribute('aria-pressed', 'true');
    await expect(connect).toHaveText('Connected');
    await expect(editor.locator('input[name=task_id]')).toHaveValue(taskId);
    await editor.locator('input[name=title]').fill('Users migration complete');
    await editor.locator('textarea[name=description]').fill('All user endpoints have moved to the new API.');
    await editor.locator('button[type=submit]').click();

    await expect(page.locator(`.milestone[data-task-id="${taskId}"]`)).toHaveAttribute('data-date', taskEnd);

    const beforeEnd = await bar.getAttribute('data-end');
    const box = await bar.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(bar).not.toHaveAttribute('data-end', beforeEnd);
    await expect(page.locator(`.milestone[data-task-id="${taskId}"]`))
      .toHaveAttribute('data-date', await bar.getAttribute('data-end'));
  });

  test('connecting a proposed task from an existing milestone saves immediately', async ({ appPage: page }) => {
    const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
    const taskId = await bar.getAttribute('data-task-id');
    const project = page.locator('.project-group').filter({ has: bar });
    const projectRowBox = await project.locator('.chart-row.proj').boundingBox();
    const barBox = await bar.boundingBox();

    await project.getByRole('button', { name: 'Add milestone' }).click();
    await page.mouse.click(barBox.x + barBox.width, projectRowBox.y + projectRowBox.height / 2);

    const editor = page.locator('#milestone-popover');
    await expect(editor).toBeVisible();
    await editor.locator('input[name=title]').fill('Users migration checkpoint');
    await editor.locator('textarea[name=description]').fill('An independent checkpoint to connect later.');
    await editor.locator('button[type=submit]').click();

    const milestone = page.locator('.milestone[data-title="Users migration checkpoint"]');
    await expect(milestone).toBeVisible();
    await expect(milestone).not.toHaveAttribute('data-task-id', taskId);
    const milestoneBox = await milestone.boundingBox();
    await page.mouse.click(milestoneBox.x + milestoneBox.width / 2, milestoneBox.y + milestoneBox.height / 2);

    await expect(editor).toBeVisible();
    const proposal = editor.locator(`#milestone-task-proposals [data-task-id="${taskId}"]`);
    await expect(proposal).toBeVisible();
    await proposal.getByRole('button', { name: 'Connect' }).click();

    await expect(editor).toHaveCount(0);
    await expect(milestone).toHaveAttribute('data-task-id', taskId);
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

  test('milestones offer an optional move explanation by default', async ({ appPage: page }) => {
    const milestone = page.locator('.milestone[data-task-id]').first();
    const oldDate = await milestone.getAttribute('data-date');
    await milestone.scrollIntoViewIfNeeded();
    const box = await milestone.boundingBox();
    const ppd = parseFloat(await page.locator('#grid-scroll').evaluate(el => el.dataset.pxPerDay));

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + ppd * 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const dialog = page.locator('#milestone-move-dialog');
    await expect(dialog).toBeVisible();
    await expect(milestone).toHaveAttribute('data-date', oldDate);
    await expect(dialog.locator('textarea[name=reason]')).not.toHaveAttribute('required', '');
    await expect(dialog.getByRole('button', { name: 'Move milestone' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Move milestone' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(milestone).not.toHaveAttribute('data-date', oldDate);

    // Editor date changes offer the same optional prompt, and retain a supplied reason.
    await milestone.click();
    const editor = page.locator('#milestone-popover');
    await editor.locator('input[name=date]').fill(oldDate);
    await editor.locator('button[type=submit]').click();
    await expect(dialog).toBeVisible();
    await dialog.locator('textarea[name=reason]').fill('Partner is ready earlier');
    await dialog.getByRole('button', { name: 'Move milestone' }).click();
    await expect(milestone).toHaveAttribute('data-date', oldDate);
    await page.goto('/activity/');
    await expect(page.locator('.activity-event[data-action="milestone.moved"]').first()).toContainText('Partner is ready earlier');
  });

  test('workspace optional milestone reasons can be disabled without disabling required reasons', async ({ appPage: page }) => {
    await page.goto('/workspaces/settings/');
    const setting = page.getByLabel('Offer a reason when moving milestones', { exact: true });
    await expect(setting).toBeChecked();
    await setting.uncheck();
    await page.locator('#workspace-milestone-settings button[type=submit]').click();
    await expect(setting).not.toBeChecked();
    await page.reload();
    await expect(setting).not.toBeChecked();
    await page.goto('/');

    const milestone = page.locator('.milestone[data-task-id]').first();
    const oldDate = await milestone.getAttribute('data-date');
    await milestone.scrollIntoViewIfNeeded();
    let box = await milestone.boundingBox();
    const ppd = parseFloat(await page.locator('#grid-scroll').getAttribute('data-px-per-day'));
    const drag = async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + ppd * 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
    };
    await drag();
    await expect(milestone).not.toHaveAttribute('data-date', oldDate);
    await expect(page.locator('#milestone-move-dialog')).not.toBeVisible();

    await milestone.click();
    const editor = page.locator('#milestone-popover');
    await editor.locator('input[name=date]').fill(oldDate);
    await editor.locator('button[type=submit]').click();
    await expect(milestone).toHaveAttribute('data-date', oldDate);
    await expect(editor).toHaveCount(0);
    await milestone.click();
    await editor.locator('input[name=require_move_reason]').check();
    await editor.locator('button[type=submit]').click();
    await expect(editor).toHaveCount(0);
    box = await milestone.boundingBox();
    await drag();
    const dialog = page.locator('#milestone-move-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Move milestone' })).toBeDisabled();
    await dialog.locator('textarea[name=reason]').fill('ab');
    await expect(dialog.getByRole('button', { name: 'Move milestone' })).toBeDisabled();
    await dialog.locator('textarea[name=reason]').fill('Required even with workspace prompts off');
    await dialog.getByRole('button', { name: 'Move milestone' }).click();
    await expect(milestone).not.toHaveAttribute('data-date', oldDate);
  });

  test('a milestone configured to require explanations prompts before a move is saved', async ({ appPage: page }) => {
    const milestone = page.locator('.milestone[data-task-id]').first();
    await milestone.scrollIntoViewIfNeeded();
    let box = await milestone.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const requireReason = page.locator('#milestone-popover input[name=require_move_reason]');
    await expect(requireReason).not.toBeChecked();
    await requireReason.check();
    await page.locator('#milestone-popover button[type=submit]').click();
    await expect(page.locator('#milestone-popover')).toHaveCount(0);

    const taskId = await milestone.getAttribute('data-task-id');
    const title = await milestone.getAttribute('data-title');
    const bar = page.locator(`#bar-${taskId}`);
    const beforeEnd = await bar.getAttribute('data-end');
    const expectedDate = new Date(`${beforeEnd}T00:00:00Z`);
    expectedDate.setUTCDate(expectedDate.getUTCDate() + 2);
    const afterDate = expectedDate.toISOString().slice(0, 10);
    await milestone.scrollIntoViewIfNeeded();
    box = await milestone.boundingBox();
    const ppd = parseFloat(await page.locator('#grid-scroll').evaluate(el => el.dataset.pxPerDay));

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + ppd * 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const dialog = page.locator('#milestone-move-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(title);
    await expect(dialog.locator('[data-original-date]')).toHaveText(germanNumericDate(beforeEnd));
    await expect(dialog.locator('[data-new-date]')).toHaveText(germanNumericDate(afterDate));
    await expect(dialog.getByRole('button', { name: 'Waiting for feedback' })).toBeVisible();
    await expect(bar).toHaveAttribute('data-end', beforeEnd);

    const submit = dialog.getByRole('button', { name: 'Move milestone' });
    await expect(submit).toBeDisabled();
    await dialog.locator('textarea[name=reason]').fill('A customer dependency needs two more days.');
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(dialog).not.toBeVisible();
    await expect(bar).toHaveAttribute('data-end', afterDate);
    await expect(page.locator(`.milestone[data-task-id="${taskId}"]`)).toHaveAttribute('data-date', afterDate);
    await expect(page.locator('#toast-slot')).toContainText(`moved to ${germanNumericDate(afterDate)}`);

    await page.goto('/activity/');
    const event = page.locator('.activity-event[data-action="milestone.moved"]').first();
    await expect(event).toContainText('A customer dependency needs two more days.');
  });

  test('changing a milestone date in the editor also prompts and Escape keeps the original date', async ({ appPage: page }) => {
    const milestone = page.locator('.chart-row.proj .milestone').first();
    const originalDate = await milestone.getAttribute('data-date');
    const proposed = new Date(`${originalDate}T00:00:00Z`);
    proposed.setUTCDate(proposed.getUTCDate() + 1);
    const proposedDate = proposed.toISOString().slice(0, 10);

    await milestone.scrollIntoViewIfNeeded();
    const box = await milestone.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const editor = page.locator('#milestone-popover');
    await expect(editor).toBeVisible();
    await editor.locator('input[name=require_move_reason]').check();
    await editor.locator('button[type=submit]').click();
    await expect(editor).toHaveCount(0);

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(editor).toBeVisible();
    await editor.locator('input[name=date]').fill(proposedDate);
    await editor.locator('button[type=submit]').click();

    const dialog = page.locator('#milestone-move-dialog');
    await expect(dialog).toBeVisible();
    await expect(milestone).toHaveAttribute('data-date', originalDate);
    await page.keyboard.press('Escape');

    await expect(dialog).not.toBeVisible();
    await expect(editor).toBeVisible();
    await expect(editor.locator('input[name=date]')).toHaveValue(originalDate);
    await expect(milestone).toHaveAttribute('data-date', originalDate);
  });

  test('production milestone modules share the hashed Datastar runtime', async ({ appPage: page }) => {
    test.setTimeout(60000);
    const staticRoot = await mkdtemp(path.join(tmpdir(), 'nano-pm-static-'));
    const cwd = path.resolve(__dirname, '../..');
    const env = djangoEnv({
      DJANGO_SETTINGS_MODULE: 'config.settings',
      DJANGO_DEBUG: 'false',
      DJANGO_SECRET_KEY: 'django-insecure-dev-only-DO-NOT-USE-IN-PROD',
      DJANGO_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      DJANGO_STATIC_ROOT: staticRoot,
    });
    let server;
    try {
      await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'collectstatic', '--noinput', '--verbosity', '0'], { cwd, env });
      // DEBUG=False uses WhiteNoise, not the development StaticFilesHandler.
      // Share only this worker's DB; never migrate or reseed its live state.
      server = await startServer(env, { initialize: false });
      const url = server.url;

      // Check module identity before executing it, so a duplicate-runtime
      // regression fails as a URL mismatch, not a browser freeze/timeout.
      const html = await (await page.request.get(`${url}/`)).text();
      const runtime = html.match(/src="([^"]*\/vendor\/datastar-rocket[^\"]+\.js)"/)[1];
      const component = html.match(/src="([^"]*\/js\/milestone-label[^\"]+\.js)"/)[1];
      expect(runtime).toMatch(/datastar-rocket-1\.0\.4\.[a-f0-9]+\.js$/);
      const source = await (await page.request.get(new URL(component, url).href)).text();
      const imported = source.match(/import\s+\{\s*rocket\s*\}\s+from\s+['"]([^'"]+)['"]/)[1];
      expect(new URL(imported, new URL(component, url)).href).toBe(new URL(runtime, url).href);

      const modules = new Set();
      const errors = [];
      page.on('request', request => {
        if (request.url().includes('/vendor/datastar-rocket')) modules.add(request.url());
      });
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await expect(page.locator('nano-milestone-label > span').first()).toHaveCSS('max-width', /^\d+(\.\d+)?px$/);
      // Exercise a real Datastar/SSE interaction with the production bundle.
      await page.locator('.milestone').first().click();
      await expect(page.locator('#milestone-popover')).toBeVisible();
      expect([...modules]).toEqual([new URL(runtime, url).href]);
      expect(errors).toEqual([]);
    } finally {
      if (server) await server.stop();
      await rm(staticRoot, { recursive: true, force: true });
    }
  });

  test('milestone components are safe when Datastar loads before their definition', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Reproduce a cold/slow component download while Datastar starts normally.
    await page.route('**/static/js/milestone-label.js', async route => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await route.continue();
    });
    await reset(request);
    await login(page);
    expect(errors).toEqual([]);
    await expect(page.locator('nano-milestone-label > span').first())
      .toHaveCSS('max-width', /^\d+(\.\d+)?px$/);
  });

  test('milestone labels truncate before nearby diamonds and reveal on hover and focus', async ({ appPage: page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const first = page.locator('.chart-row.proj .milestone').first();
    const firstId = await first.getAttribute('data-milestone-id');
    const projectId = await first.getAttribute('data-project-id');
    const date = await first.getAttribute('data-date');
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextDate = next.toISOString().slice(0, 10);
    const title = 'A long milestone title that must remain readable in full';

    // Use the real Datastar bridge and wait for server-committed attributes.
    await page.evaluate(({ firstId, title }) => {
      window.dispatchEvent(new CustomEvent('nano-commit', { detail: {
        url: `/milestones/${firstId}/update/`, data: { title },
      } }));
    }, { firstId, title });
    await expect(first).toHaveAttribute('data-title', title);
    await page.evaluate(({ projectId, nextDate }) => {
      window.dispatchEvent(new CustomEvent('nano-commit', { detail: {
        url: `/projects/${projectId}/milestones/`, data: { date: nextDate },
      } }));
    }, { projectId, nextDate });
    const editor = page.locator('#milestone-popover');
    await expect(editor).toBeVisible();
    const secondId = await editor.getAttribute('data-milestone-id');
    await editor.locator('input[name=title]').fill('Nearby checkpoint');
    await editor.locator('textarea[name=description]').fill('A close checkpoint.');
    await editor.locator('button[type=submit]').click();
    await expect(editor).toHaveCount(0);
    const second = page.locator(`#ms-${secondId}`);
    await expect(second).toHaveAttribute('data-date', nextDate);
    await first.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);

    const label = page.locator(`#ms-${firstId} + .milestone-label`);
    await expect(label).toHaveText(title);
    await expect.poll(() => label.evaluate(el => {
      const text = el.firstElementChild || el;
      return text.scrollWidth > text.clientWidth;
    })).toBe(true);
    expect(await label.evaluate(el => el.getBoundingClientRect().right))
      .toBeLessThan(await second.evaluate(el => el.getBoundingClientRect().left));
    expect(await label.evaluate(el => getComputedStyle(el.firstElementChild || el).textOverflow)).toBe('ellipsis');

    await first.hover();
    await expect.poll(() => label.evaluate(el => {
      const text = el.firstElementChild || el;
      return text.scrollWidth <= text.clientWidth;
    })).toBe(true);
    expect(await label.evaluate(el => Number(getComputedStyle(el).zIndex)))
      .toBeGreaterThan(await second.evaluate(el => Number(getComputedStyle(el).zIndex)));
    expect(await label.evaluate(el => getComputedStyle(el.firstElementChild || el).backgroundColor))
      .not.toBe('rgba(0, 0, 0, 0)');

    // The foreground label must not steal hover from a covered diamond.
    await second.hover();
    await expect.poll(() => label.evaluate(el => {
      const text = el.firstElementChild || el;
      return text.scrollWidth > text.clientWidth;
    })).toBe(true);
    await first.focus();
    await expect.poll(() => label.evaluate(el => {
      const text = el.firstElementChild || el;
      return text.scrollWidth <= text.clientWidth;
    })).toBe(true);
    await first.press('Enter');
    await expect(page.locator('#milestone-popover input[name=title]')).toHaveValue(title);
    expect(errors).toEqual([]);
  });

  test('milestone label components recalculate after density changes and SSE patches', async ({ appPage: page }) => {
    const first = page.locator('.chart-row.proj .milestone').first();
    const id = await first.getAttribute('data-milestone-id');
    const date = await first.getAttribute('data-date');
    const projectId = await first.getAttribute('data-project-id');
    const title = 'Long checkpoint label for overlap testing';
    await page.evaluate(({ id, title }) => {
      window.dispatchEvent(new CustomEvent('nano-commit', { detail: {
        url: `/milestones/${id}/update/`, data: { title },
      } }));
    }, { id, title });
    await expect(first).toHaveAttribute('data-title', title);
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    await page.evaluate(({ projectId, date }) => {
      window.dispatchEvent(new CustomEvent('nano-commit', { detail: {
        url: `/projects/${projectId}/milestones/`, data: { date },
      } }));
    }, { projectId, date: next.toISOString().slice(0, 10) });
    const editor = page.locator('#milestone-popover');
    await expect(editor).toBeVisible();
    const newId = await editor.getAttribute('data-milestone-id');
    await editor.locator('input[name=title]').fill('Nearby checkpoint');
    await editor.locator('textarea[name=description]').fill('A close checkpoint.');
    await editor.locator('button[type=submit]').click();
    await expect(editor).toHaveCount(0);
    await first.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const label = page.locator(`#ms-${id} + .milestone-label`);
    const width = () => label.evaluate(el => (el.firstElementChild || el).getBoundingClientRect().width);
    await expect.poll(width).toBeLessThan(36);
    const before = await width();
    await page.locator('#zoom-slider').evaluate(el => {
      el.value = el.max;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#grid-scroll')).toHaveAttribute('data-px-per-day', '72');
    await expect.poll(width).toBeGreaterThan(before + 30);
    await first.scrollIntoViewIfNeeded();
    await first.hover();
    await expect.poll(width).toBeGreaterThan(100);
    await page.mouse.move(0, 0);

    // Deleting the neighbour must release the space without a reload.
    await page.evaluate(newId => {
      window.dispatchEvent(new CustomEvent('nano-commit', { detail: {
        url: `/milestones/${newId}/delete/`, data: {},
      } }));
    }, newId);
    await expect(page.locator(`#ms-${newId}`)).toHaveCount(0);
    await expect.poll(width).toBeGreaterThan(100);
    await expect(label).toHaveText(title);
  });

  test('clicking a task milestone opens the regular milestone editor', async ({ appPage: page }) => {
    const ms = page.locator('.chart-row.proj .milestone').first();
    const taskId = await ms.getAttribute('data-task-id');
    await ms.scrollIntoViewIfNeeded();
    const box = await ms.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('#milestone-popover');
    await expect(page.locator('#milestone-popover input[name=title]')).toHaveValue('v2 API beta');
    const editor = page.locator('#milestone-popover');
    await expect(editor.locator('textarea[name=description]')).toBeVisible();
    await expect(editor.locator('#milestone-task-proposals')).toHaveCount(0);
    await expect(editor.locator('button', { hasText: 'Delete' })).toBeVisible();
    await expect(editor.locator('button', { hasText: 'Cancel' })).toHaveCount(0);
    await expect(page.locator(`#bar-${taskId}`)).toBeVisible();
  });

  test('the milestone move-reason setting wraps inside the drawer', async ({ appPage: page }) => {
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    const milestone = page.locator('.chart-row.proj .milestone').first();
    await milestone.scrollIntoViewIfNeeded();
    const box = await milestone.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    const setting = page.locator('#milestone-require-move-reason');
    await expect(setting).toBeVisible();
    expect(await setting.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
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

  test('the task milestone control only selects existing milestones', async ({ appPage: page }) => {
    await page.locator('.bar', { hasText: 'Migrate /users endpoints' }).click();
    const select = page.locator('#task-popover select[name=milestone_id]');
    await expect(select).toBeVisible();
    await expect(page.locator('#task-popover input[name=milestone_title]')).toHaveCount(0);
    await expect(select.locator('option')).toHaveCount(1);
    await expect(select.locator('option').first()).toHaveAttribute('value', '');
  });

  test('clearing a task milestone selection disconnects without deleting the milestone', async ({ appPage: page }) => {
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    const bar = page.locator('.bar', { hasText: 'Cutover and deprecation' });
    const taskId = await bar.getAttribute('data-task-id');
    const milestone = page.locator(`.milestone[data-task-id="${taskId}"]`);
    const milestoneId = await milestone.getAttribute('data-milestone-id');
    await bar.click();
    await expect(page.locator('#task-popover')).toBeVisible();
    await page.locator('#task-milestone-select').selectOption('');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('.chart-row.proj .milestone')).toHaveCount(2);
    await expect(page.locator(`#ms-${milestoneId}`)).not.toHaveAttribute('data-task-id', taskId);
  });

  test('task milestone selection only lists free milestones from the same project', async ({ appPage: page }) => {
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
    const select = page.locator('#task-milestone-select');
    await expect(select.locator('option', { hasText: 'Onboarding-only checkpoint' })).toHaveCount(0);
  });

  test('task milestone selection can link an existing free milestone', async ({ appPage: page }) => {
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

    const select = page.locator('#task-milestone-select');
    await expect(select.locator(`option[value="${milestoneId}"]`)).toHaveText('Reusable checkpoint');

    await select.selectOption(milestoneId);
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
    await expect(milestoneGhost.locator('.creation-date-tooltip')).toHaveText(/\d{2}\.\d{2}\.\d{4}/);
    const initialGhostLeft = await milestoneGhost.evaluate(el => el.style.left);

    const chartXForMilestone = sidebar.x + sidebar.width + 180;
    const chartYForMilestone = projectRowBox.y + projectRowBox.height / 2;
    await page.mouse.move(chartXForMilestone, chartYForMilestone);
    await expect.poll(() => milestoneGhost.evaluate(el => el.style.left)).not.toBe(initialGhostLeft);
    await page.mouse.down();
    await expect(page.locator('.creation-milestone-preview')).toBeVisible();
    await expect(page.locator('.creation-milestone-preview .creation-date-tooltip')).toHaveText(/\d{2}\.\d{2}\.\d{4}/);
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

  test('hover-only project list link opens a dedicated project detail page', async ({ appPage: page }) => {
    const row = page.locator('.left-cell.proj', { hasText: 'API Migration' });
    const link = row.getByRole('link', { name: 'Open project details' });
    await page.mouse.move(700, 20);
    await expect(link).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(link).toHaveCSS('opacity', '1');
    await link.focus();
    await page.mouse.move(700, 20);
    await expect(link).toHaveCSS('opacity', '1');
    await link.press('Enter');
    await expect(page).toHaveURL(/\/projects\/\d+\/$/);
    const detail = page.locator('#project-detail-page');
    await expect(detail.getByRole('heading', { name: 'API Migration', exact: true })).toBeVisible();
    await expect(detail).toContainText('Move public API traffic to the new v2 platform.');
    await expect(detail.locator('[data-task-id]')).toHaveCount(3);
    await expect(detail).toContainText('Migrate /users endpoints');
    await expect(detail).toContainText('Alex Chen');
    await expect(detail.locator('[data-milestone-id]')).toHaveCount(1);
    await expect(detail).toContainText('v2 API beta');
    await expect(detail).not.toContainText('Tutorial flow v2');
    await expect(detail).not.toContainText('Soft launch');
    await page.reload();
    await expect(detail.getByRole('heading', { name: 'API Migration', exact: true })).toBeVisible();
    await detail.getByRole('link', { name: 'Back to Projects' }).click();
    await expect(page.locator('#grid-scroll')).toBeVisible();
  });

  test('project sidebar maximize link opens the same project detail page', async ({ appPage: page }) => {
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    const sidebar = page.locator('#project-popover');
    await expect(sidebar).toBeVisible();
    const link = sidebar.getByRole('link', { name: 'Open project details' });
    await page.mouse.move(700, 20);
    await expect(link).toHaveCSS('opacity', '0');
    await sidebar.hover();
    await expect(link).toHaveCSS('opacity', '1');
    await expect(link.locator('svg')).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/projects\/\d+\/$/);
    await expect(page.locator('#project-detail-page h1')).toHaveText('API Migration');
  });

  test('project detail is workspace-scoped and handles empty projects', async ({ appPage: page }) => {
    const id = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    const missing = await page.goto('/projects/999999/');
    expect(missing.status()).toBe(404);
    await page.goto('/');
    await page.locator('.left-cell.add-project-row').first().click();
    const row = page.locator('.left-cell.proj', { hasText: 'New project' });
    await expect(row).toBeVisible();
    const emptyId = await row.getAttribute('data-project-id');
    await page.goto(`/projects/${emptyId}/`);
    await expect(page.locator('#project-detail-page')).toContainText('No tasks yet.');
    await expect(page.locator('#project-detail-page')).toContainText('No milestones yet.');
    await expect(page.locator('#project-detail-page')).toContainText('Nobody assigned');
    await expect(page.locator('#project-detail-page')).toContainText('No description yet.');
    await postForm(page, '/workspaces/', { name: 'Other workspace' });
    const foreign = await page.goto(`/projects/${id}/`);
    expect(foreign.status()).toBe(404);
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

  test('workspace Teams notification settings persist without exposing webhook secrets', async ({ appPage: page }) => {
    const url = 'http://127.0.0.1:54321/teams?sig=test-secret';
    await configureTeams(page, url, ['milestone.created', 'milestone.updated']);
    await page.reload();
    await expect(page.locator('#teams-connection-status')).toHaveText('Webhook configured');
    await expect(page.getByLabel('Microsoft Teams webhook URL')).toHaveValue('');
    await expect(page.getByLabel('Milestone created', { exact: true })).toBeChecked();
    await expect(page.getByLabel('Milestone date changed', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('Milestone details changed', { exact: true })).toBeChecked();
    await expect(page.getByLabel('Milestone deleted', { exact: true })).not.toBeChecked();
    await page.goto('/activity/');
    await expect(page.locator('body')).not.toContainText('test-secret');
    await expect(page.locator('body')).toContainText('Microsoft Teams webhook URL');
    await page.goto('/');
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await expect(page.locator('#project-popover input[name=teams_webhook_url]')).toHaveCount(0);
  });

  test('Teams notifications respect selected milestone events', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await configureTeams(page, webhook.url, ['milestone.updated']);
      await page.goto('/');

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
      await page.locator('#milestone-move-dialog').getByRole('button', { name: 'Move milestone' }).click();

      await page.waitForFunction(
        ([id, before]) => {
          const el = document.querySelector(`#ms-${id}`);
          return el && el.dataset.date !== before;
        },
        [milestoneId, oldDate],
        { timeout: 5000 }
      );
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(0);

      const movedMilestone = page.locator(`#ms-${milestoneId}`);
      await movedMilestone.scrollIntoViewIfNeeded();
      const movedBox = await movedMilestone.boundingBox();
      await page.mouse.click(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
      await expect(page.locator('#milestone-popover')).toBeVisible();
      await page.locator('#milestone-popover input[name=title]').fill('v2 API beta updated for Teams');
      await page.locator('#milestone-popover button[type=submit]').click();
      await expect(page.locator('#milestone-popover')).toHaveCount(0);

      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      expect(webhook.requests[0].method).toBe('POST');
      expect(webhook.requests[0].json.type).toBe('message');
      const card = webhook.requests[0].json.attachments[0].content;
      expect(webhook.requests[0].json.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
      expect(card.type).toBe('AdaptiveCard');
      expectTeamsLayout(card, 'API Migration', 'Meilenstein aktualisiert', 'v2 API beta updated for Teams');
      expect(card.body[3].text).toBe('Bisheriger Titel: v2 API beta');
      expect(card.body.at(-1)).toMatchObject({ text: 'demo', size: 'Small', isSubtle: true });
    } finally {
      await webhook.close();
    }
  });

  test('Teams cards snapshot the actors full name when the event is queued', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      const milestoneId = await page.locator('.milestone').first().getAttribute('data-milestone-id');
      await configureTeams(page, webhook.url, ['milestone.updated']);
      await page.goto('/profile/');
      await page.getByLabel('First name', { exact: true }).fill('Philipp');
      await page.getByLabel('Last name', { exact: true }).fill('Eichhorn');
      await page.getByRole('button', { name: 'Save profile', exact: true }).click();
      expect(await postForm(page, `/milestones/${milestoneId}/update/`, { title: 'Actor name snapshot' })).toBe(200);
      // Delivery must use the event's actor snapshot, not a later profile edit.
      const workspace = await page.locator('#profile-form input[name=workspace_id]').inputValue();
      expect(await postForm(page, '/profile/', {
        workspace_id: workspace, first_name: 'Changed', last_name: 'After enqueue',
        email: '', teams_upn: '',
      })).toBe(200);
      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      const card = webhook.requests[0].json.attachments[0].content;
      expect(card.body.at(-1)).toMatchObject({ text: 'Philipp Eichhorn', size: 'Small', isSubtle: true });
    } finally { await webhook.close(); }
  });

  test('Teams description notifications include the new milestone description', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await configureTeams(page, webhook.url, ['milestone.updated']);
      await page.goto('/');

      const milestone = page.locator('.chart-row.proj .milestone').first();
      await milestone.scrollIntoViewIfNeeded();
      const box = await milestone.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.locator('#milestone-popover')).toBeVisible();

      const description = 'Neue Beschreibung für Teams mit mehr Kontext.';
      await page.locator('#milestone-popover textarea[name=description]').fill(description);
      await page.locator('#milestone-popover button[type=submit]').click();
      await expect(page.locator('#milestone-popover')).toHaveCount(0);

      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      const card = webhook.requests[0].json.attachments[0].content;
      expectTeamsLayout(card, 'API Migration', 'Meilenstein aktualisiert', 'v2 API beta');
      expect(card.body[3].text).toBe(`Beschreibung geändert:\n\n${description}`);
      expect(card.body.at(-1).text).toBe('demo');
    } finally {
      await webhook.close();
    }
  });

  for (const moveVia of ['drag', 'editor']) {
    test(`Teams milestone move notifications include the supplied reason via ${moveVia}`, async ({ appPage: page }) => {
      const webhook = await startWebhookServer();
      try {
        await configureTeams(page, webhook.url, ['milestone.moved']);
        await page.goto('/');
        const milestone = page.locator('.chart-row.proj .milestone').first();
        const oldDate = await milestone.getAttribute('data-date');
        const proposed = new Date(`${oldDate}T00:00:00Z`);
        proposed.setUTCDate(proposed.getUTCDate() + 2);
        const newDate = proposed.toISOString().slice(0, 10);
        await milestone.scrollIntoViewIfNeeded();
        let box = await milestone.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        const editor = page.locator('#milestone-popover');
        await editor.locator('input[name=require_move_reason]').check();
        await editor.locator('button[type=submit]').click();
        await expect(editor).toHaveCount(0);
        await expect(milestone).toHaveAttribute('data-requires-move-reason', 'true');

        await milestone.scrollIntoViewIfNeeded();
        box = await milestone.boundingBox();
        if (moveVia === 'editor') {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await editor.locator('input[name=date]').fill(newDate);
          await editor.locator('button[type=submit]').click();
        } else {
          const ppd = parseFloat(await page.locator('#grid-scroll').getAttribute('data-px-per-day'));
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2 + ppd * 2, box.y + box.height / 2, { steps: 8 });
          await page.mouse.up();
        }
        const dialog = page.locator('#milestone-move-dialog');
        await expect(dialog).toBeVisible();
        const reason = 'A customer dependency needs two more days.';
        await dialog.locator('textarea[name=reason]').fill(reason);
        await dialog.getByRole('button', { name: 'Move milestone' }).click();
        await expect(milestone).toHaveAttribute('data-date', newDate);

        await deliverTeamsNotifications();
        expect(webhook.requests).toHaveLength(1);
        const card = webhook.requests[0].json.attachments[0].content;
        expectTeamsLayout(card, 'API Migration', 'Termin verschoben', 'v2 API beta');
        expect(card.body[3].text).toBe(`Jetzt **${germanDate(newDate)}** — 2 Tage später`);
        expect(card.body[4]).toMatchObject({ text: `**Grund:** ${reason}`, wrap: true });
        expect(card.body[5]).toMatchObject({ text: 'demo', size: 'Small', isSubtle: true });
        expect(card.body).toHaveLength(6);
      } finally {
        await webhook.close();
      }
    });
  }

  test('Teams milestone move notifications use the project-first layout and compact German dates', async ({ appPage: page }) => {
    const webhook = await startWebhookServer();
    try {
      await configureTeams(page, webhook.url);
      await page.goto('/');

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
      await page.locator('#milestone-move-dialog').getByRole('button', { name: 'Move milestone' }).click();

      await page.waitForFunction(
        ([id, before]) => {
          const el = document.querySelector(`#ms-${id}`);
          return el && el.dataset.date !== before;
        },
        [milestoneId, oldDate],
        { timeout: 5000 }
      );

      await deliverTeamsNotifications();
      expect(webhook.requests).toHaveLength(1);
      const newDate = await page.locator(`#ms-${milestoneId}`).getAttribute('data-date');
      const card = webhook.requests[0].json.attachments[0].content;
      expectTeamsLayout(card, 'API Migration', 'Termin verschoben', 'v2 API beta');
      expect(card.body[3].text).toBe(`Jetzt **${germanDate(newDate)}** — 2 Tage später`);
      expect(card.body[4]).toMatchObject({ text: 'demo', size: 'Small', isSubtle: true });
      expect(card.body).toHaveLength(5);
      expect(JSON.stringify(card)).not.toContain('Grund:');
      expect(JSON.stringify(card)).not.toContain(germanDate(oldDate));
    } finally {
      await webhook.close();
    }
  });

  test('projects support multiple responsible people who can manage related tasks', async ({ appPage: page }) => {
    const project = page.locator('.left-cell.proj', { hasText: 'API Migration' });
    await project.click();
    const responsible = page.locator('#project-responsible-people');
    const pills = page.locator('#project-responsible-pills .project-responsible-pill:visible');
    await expect(responsible).toBeVisible();
    await expect(responsible.locator('option:not([value=""])')).toHaveCount(3);

    const alexValue = await responsible.locator('option', { hasText: 'Alex Chen' }).getAttribute('value');
    const rileyValue = await responsible.locator('option', { hasText: 'Riley Wong' }).getAttribute('value');
    await responsible.selectOption(alexValue);
    await responsible.selectOption(rileyValue);
    await expect(pills).toHaveCount(2);
    await expect(pills).toContainText(['Alex Chen', 'Riley Wong']);

    const removeRiley = page.getByRole('button', { name: 'Remove Riley Wong' });
    await expect(removeRiley.locator('svg')).toHaveCount(1);
    await removeRiley.click();
    await expect(pills).toHaveCount(1);
    await responsible.selectOption(rileyValue);

    await page.click('#project-popover button[type=submit]');
    await expect(page.locator('#project-popover')).toHaveCount(0);
    await expect(project.locator('.project-assignees')).toHaveText('Alex, Riley');

    await project.click();
    await expect(page.locator('#project-responsible-pills .project-responsible-pill:visible')).toHaveCount(2);
    await expect(page.locator('#project-responsible-pills')).toContainText('Alex Chen');
    await expect(page.locator('#project-responsible-pills')).toContainText('Riley Wong');

    await page.locator('.sign-out-btn').click();
    await page.waitForURL('**/accounts/login/');
    await page.fill('input[name=username]', 'member1');
    await page.fill('input[name=password]', 'member1');
    await page.click('button[type=submit]');
    await page.waitForURL('/');

    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await expect(page.locator('#project-popover button', { hasText: 'Delete project' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Alex is not assigned to this task, but is responsible for its project.
    await page.locator('.bar', { hasText: 'Cutover and deprecation' }).click({ force: true });
    await expect(page.locator('#task-popover button[type=submit]')).toBeVisible();
    await page.fill('#task-popover input[name=title]', 'Cutover managed by project lead');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('.bar', { hasText: 'Cutover managed by project lead' })).toBeVisible();

    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#project-popover button', { hasText: 'Delete project' }).click();
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toHaveCount(0);
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

  test('workspace settings sub-navigation isolates sections and preserves the selected section', async ({ appPage: page }) => {
    await page.locator('.ws-settings-link').click();
    const nav = page.getByRole('navigation', { name: 'Settings sections', exact: true });
    await expect(nav.getByRole('link', { name: 'General', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#workspace-settings-name')).toBeVisible();
    await expect(page.locator('#workspace-workload-settings, #workspace-gitlab-settings, #workspace-roadmap-settings')).toHaveCount(0);
    await nav.getByRole('link', { name: 'Workload', exact: true }).click();
    await expect(page).toHaveURL('/workspaces/settings/workload/');
    await page.getByRole('switch', { name: 'Enable workload reporting', exact: true }).check();
    await expect(page.locator('[data-workload-setting="workload_enabled"]')).toHaveAttribute('data-enabled', 'true');
    await page.reload();
    await expect(nav.getByRole('link', { name: 'Workload', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('switch', { name: 'Enable workload reporting', exact: true })).toBeChecked();
    await expect(page.locator('#workspace-settings-name, #workspace-gitlab-settings, #workspace-roadmap-settings')).toHaveCount(0);
    await nav.getByRole('link', { name: 'Integrations', exact: true }).click();
    await expect(page).toHaveURL('/workspaces/settings/integrations/');
    await expect(page.locator('#workspace-gitlab-settings')).toBeVisible();
    await page.getByLabel('GitLab instance URL').fill('http://example.com');
    await page.getByRole('button', { name: 'Save GitLab connection', exact: true }).click();
    await expect(nav.getByRole('link', { name: 'Integrations', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#workspace-gitlab-settings')).toContainText('Enter an HTTPS GitLab origin');
    await expect(page.locator('#workspace-settings-name, #workspace-workload-settings, #workspace-roadmap-settings')).toHaveCount(0);
    await nav.getByRole('link', { name: 'Roadmap', exact: true }).click();
    await expect(page).toHaveURL('/workspaces/settings/sharing/');
    await page.getByRole('button', { name: 'Enable public roadmap', exact: true }).click();
    await expect(page).toHaveURL('/workspaces/settings/sharing/');
    await expect(nav.getByRole('link', { name: 'Roadmap', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#public-roadmap-link')).toBeVisible();
    await nav.getByRole('link', { name: 'General', exact: true }).click();
    await page.locator('main').getByLabel('Workspace name', { exact: true }).fill('Focused settings');
    await page.locator('main').getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page).toHaveURL('/workspaces/settings/');
    await expect(page.locator('main').getByLabel('Workspace name', { exact: true })).toHaveValue('Focused settings');
  });

  test('workspace settings mobile selector navigates to bookmarkable sections', async ({ appPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/workspaces/settings/');
    const selector = page.getByLabel('Settings section', { exact: true });
    await expect(selector).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Settings sections', exact: true })).not.toBeVisible();
    for (const section of ['workload', 'integrations', 'sharing']) {
      await selector.selectOption(`/workspaces/settings/${section}/`);
      await expect(page).toHaveURL(`/workspaces/settings/${section}/`);
      await page.reload();
      await expect(selector).toHaveValue(`/workspaces/settings/${section}/`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.goBack();
    await expect(selector).toHaveValue('/workspaces/settings/integrations/');
  });

  test('workspace settings are reachable from the name cog and picker and gate workload configuration', async ({ appPage: page }) => {
    const cog = page.locator('.sidebar-workspace-display').getByRole('link', { name: 'Workspace settings', exact: true });
    await expect(cog).toBeVisible();
    await expect(cog).toHaveAttribute('href', '/workspaces/settings/');
    await page.locator('.ws-chevron-btn').click();
    const picker = page.locator('#workspace-menu');
    await expect(picker.getByRole('button', { name: 'Enable public roadmap', exact: true })).toHaveCount(0);
    await picker.getByRole('link', { name: 'Workspace settings', exact: true }).click();
    await expect(page).toHaveURL(/\/workspaces\/settings\/$/);
    await expect(page.getByRole('heading', { name: 'Workspace settings', exact: true })).toBeVisible();
    await page.locator('main').getByLabel('Workspace name', { exact: true }).fill('Planning');
    await page.locator('main').getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page).toHaveURL(/\/workspaces\/settings\/$/);
    await expect(page.locator('#workspace-name')).toHaveText('Planning');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Workload', exact: true }).click();
    const enabled = page.getByRole('switch', { name: 'Enable workload reporting', exact: true });
    const categories = page.getByRole('table', { name: 'Categories', exact: true });
    await expect(enabled).not.toBeChecked();
    await expect(categories).toHaveCount(0);
    await expect(page.getByLabel('Include members by default', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Participation overrides', exact: true })).toHaveCount(0);
    await expect(page.locator('.drawer-side .menu a[href="/workspaces/workload/"]')).toHaveCount(0);
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await enabled.check();
    await expect(page.locator('[data-workload-setting="workload_enabled"]')).toHaveAttribute('data-enabled', 'true');
    await expect(categories.locator('tbody tr')).toHaveCount(3);
    await expect(page.getByLabel('Include members by default', { exact: true })).toBeChecked();
    await expect(page.getByRole('table', { name: 'Participation overrides', exact: true })).toBeVisible();
    await categories.locator('tbody tr').first().getByLabel('Category name', { exact: true }).fill('Operations');
    await categories.locator('tbody tr').first().getByLabel('Category name', { exact: true }).press('Tab');
    await expect(categories.locator('tbody tr').first()).toHaveAttribute('data-name', 'Operations');
    await enabled.uncheck();
    await expect(categories).toHaveCount(0);
    await expect(page.getByLabel('Include PMs by default', { exact: true })).toHaveCount(0);
    await enabled.check();
    await expect(categories.locator('tbody tr')).toHaveCount(3);
    await expect(categories.locator('tbody tr').first().getByLabel('Category name', { exact: true })).toHaveValue('Operations');
    expect(navigations).toBe(0);
    await page.reload();
    await expect(enabled).toBeChecked();
    await expect(categories.locator('tbody tr')).toHaveCount(3);
  });

  test('workspace settings configure the public roadmap and keep changes on the settings page', async ({ appPage: page, request }) => {
    await page.locator('.sidebar-workspace-display').getByRole('link', { name: 'Workspace settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Roadmap', exact: true }).click();
    await page.getByRole('button', { name: 'Enable public roadmap', exact: true }).click();
    await expect(page).toHaveURL(/\/workspaces\/settings\/sharing\/$/);
    await page.getByLabel('Public roadmap title', { exact: true }).fill('Product roadmap');
    await page.getByLabel('Public roadmap description', { exact: true }).fill('Upcoming releases');
    await page.locator('#workspace-roadmap-settings').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(/\/workspaces\/settings\/sharing\/$/);
    await expect(page.getByLabel('Public roadmap title', { exact: true })).toHaveValue('Product roadmap');
    const oldHref = await page.locator('#public-roadmap-link').getAttribute('href');
    const roadmap = await request.get(oldHref);
    expect(roadmap.status()).toBe(200);
    expect(await roadmap.text()).toContain('Upcoming releases');
    await page.getByRole('button', { name: 'Regenerate public link', exact: true }).click();
    await expect(page).toHaveURL(/\/workspaces\/settings\/sharing\/$/);
    const newHref = await page.locator('#public-roadmap-link').getAttribute('href');
    expect(newHref).not.toBe(oldHref);
    expect((await request.get(oldHref)).status()).toBe(404);
    expect((await request.get(newHref)).status()).toBe(200);
    await page.getByRole('button', { name: 'Disable public roadmap', exact: true }).click();
    await expect(page).toHaveURL(/\/workspaces\/settings\/sharing\/$/);
    await expect(page.getByLabel('Public roadmap title', { exact: true })).toHaveCount(0);
    expect((await request.get(newHref)).status()).toBe(404);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Workload', exact: true }).click();
    await expect(page.getByLabel('Enable workload reporting', { exact: true })).not.toBeChecked();
  });

  test('workspace settings are PM-only and scoped to the active workspace', async ({ appPage: page }) => {
    await page.locator('.ws-chevron-btn').click();
    await page.fill('#workspace-create-name', 'Settings sandbox');
    await page.locator('#workspace-create-name').press('Enter');
    await page.waitForURL('/');
    await page.goto('/workspaces/settings/workload/');
    await page.getByLabel('Enable workload reporting', { exact: true }).check();
    await expect(page.locator('[data-workload-setting="workload_enabled"]')).toHaveAttribute('data-enabled', 'true');
    await page.goto('/workspaces/settings/');
    const optionalReasons = page.getByLabel('Offer a reason when moving milestones', { exact: true });
    await optionalReasons.uncheck();
    await page.locator('#workspace-milestone-settings button[type=submit]').click();
    await expect(optionalReasons).not.toBeChecked();
    await page.locator('.ws-chevron-btn').click();
    await page.locator('#workspace-menu .workspace-item', { hasText: "demo's workspace" }).click();
    await page.waitForURL('/');
    await page.goto('/workspaces/settings/workload/');
    await expect(page.getByLabel('Enable workload reporting', { exact: true })).not.toBeChecked();
    await expect(page.getByRole('table', { name: 'Categories', exact: true })).toHaveCount(0);
    await page.goto('/workspaces/settings/');
    await expect(optionalReasons).toBeChecked();
    await signInAs(page, 'member1');
    await expect(page.getByRole('link', { name: 'Workspace settings', exact: true })).toHaveCount(0);
    expect(await postForm(page, '/workspaces/settings/', { prompt_milestone_move_reason: 'on' })).toBe(403);
    for (const section of ['', 'workload/', 'integrations/', 'sharing/']) {
      expect((await page.goto('/workspaces/settings/' + section)).status()).toBe(403);
    }
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
    await page.goto('/workspaces/settings/sharing/');
    await expect(page.locator('#public-roadmap-link')).toHaveCount(0);
    await page.getByRole('button', { name: 'Enable public roadmap' }).click();
    await page.waitForURL('/workspaces/settings/sharing/');

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
    expect(body).not.toContain('Migrate /users endpoints');
    expect(body).not.toContain('Alex Chen');

    await page.getByRole('button', { name: 'Disable public roadmap' }).click();
    await page.waitForURL('/workspaces/settings/sharing/');
    const revoked = await request.get(href);
    expect(revoked.status()).toBe(404);
  });

  test('public roadmap shows project responsible people inline and in drawers but not task assignees', async ({ appPage: page, browser }) => {
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    const responsible = page.locator('#project-responsible-people');
    for (const name of ['Alex Chen', 'Riley Wong']) {
      const id = await responsible.locator('option', { hasText: name }).getAttribute('value');
      await responsible.selectOption(id);
    }
    await page.locator('#project-popover button[type=submit]').click();
    await expect(page.locator('#project-popover')).toHaveCount(0);
    const href = await enableRoadmap(page);
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      for (const width of [1280, 390]) {
        await visitor.setViewportSize({ width, height: 844 });
        await visitor.goto(href);
        const project = visitor.locator('.roadmap-project-label').filter({ hasText: 'API Migration' });
        const summary = project.locator('[data-project-responsible-summary]');
        await expect(summary).toBeVisible();
        await expect(summary).toHaveText('Alex, Riley');
        await expect(summary).toHaveAttribute('title', 'Alex Chen, Riley Wong');
        await expect(project).not.toContainText('Sam');
        const unassignedProject = visitor.locator('.roadmap-project-label').filter({ hasText: 'Infra hardening' });
        await expect(unassignedProject.locator('[data-project-responsible-summary]')).toHaveCount(0);
        await project.getByRole('button', { name: 'API Migration', exact: true }).click();
        const drawer = visitor.locator('#drawer');
        await expect(drawer.getByRole('heading', { name: 'Responsible people', exact: true })).toBeVisible();
        await expect(drawer.locator('[data-project-responsible]')).toHaveText(['Alex Chen', 'Riley Wong']);
        await expect(drawer).not.toContainText('Sam Patel');
        await expect(drawer).not.toContainText('Cutover and deprecation');
        await expect(drawer.locator('input, select, textarea, form, [data-person-id]')).toHaveCount(0);
        await visitor.keyboard.press('Escape');
        await visitor.locator('.roadmap-project-label').getByRole('button', { name: 'Infra hardening', exact: true }).click();
        await expect(drawer).toContainText('Nobody assigned');
        await expect(drawer).not.toContainText('Alex Chen');
        await visitor.keyboard.press('Escape');
      }
    } finally {
      await context.close();
    }
  });

  test('public roadmap opens project descriptions from compact clickable project names', async ({ appPage: page, browser }) => {
    const projects = await page.locator('.left-cell.proj').evaluateAll(elements => elements.map(el => el.dataset.projectId));
    const description = ['Project overview', ...Array.from({ length: 30 }, (_, i) => `Detailed project context ${i + 1}.`), 'End of full project description.'].join('\n');
    expect(await postForm(page, `/projects/${projects[0]}/update/`, { description })).toBe(200);
    expect(await postForm(page, `/projects/${projects[1]}/update/`, { description: 'Short summary.' })).toBe(200);
    expect(await postForm(page, `/projects/${projects[2]}/update/`, { description: '' })).toBe(200);
    const href = await enableRoadmap(page);
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      for (const width of [1280, 390]) {
        await visitor.setViewportSize({ width, height: 844 });
        await visitor.goto(href);
        const project = visitor.locator('.roadmap-project-label').first();
        await expect(visitor.locator('[data-project-description-preview]')).toHaveCount(0);
        await expect(visitor.getByRole('button', { name: /Read more/ })).toHaveCount(0);
        await expect(project.locator('p')).toHaveCount(0);
        await expect(project).not.toContainText('Project overview');
        const projectName = project.getByRole('button', { name: 'API Migration', exact: true });
        await expect(projectName).toBeVisible();
        const rowHeight = (await project.boundingBox()).height;
        expect(rowHeight).toBeLessThan(120);
        await projectName.focus();
        await visitor.keyboard.press('Enter');
        const drawer = visitor.locator('#drawer');
        await expect(drawer.getByRole('heading', { name: 'API Migration', exact: true })).toBeVisible();
        await expect(drawer).toContainText('End of full project description.');
        await expect(drawer.locator('p')).toHaveText(description);
        await expect(drawer.locator('form, input, textarea, select')).toHaveCount(0);
        await expect(projectName).toHaveAttribute('aria-expanded', 'true');
        await expect(drawer.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
        expect((await project.boundingBox()).height).toBe(rowHeight);
        await visitor.keyboard.press('Escape');
        await expect(drawer).not.toBeVisible();
        await expect(projectName).toBeFocused();
        await expect(projectName).toHaveAttribute('aria-expanded', 'false');
        await projectName.click();
        await drawer.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(drawer).not.toBeVisible();
        await expect(projectName).toBeFocused();
        for (const [index, text] of [[1, 'Short summary.'], [2, 'No description yet.']]) {
          await visitor.locator('.roadmap-project-label').nth(index).locator('[data-roadmap-project]').click();
          await expect(drawer.locator('p')).toHaveText(text);
          await visitor.keyboard.press('Escape');
        }
        // Sharing the drawer must not leak project content into milestone details.
        const milestone = visitor.getByRole('button', { name: /v2 API beta/ });
        await milestone.scrollIntoViewIfNeeded();
        await milestone.click();
        await expect(drawer.getByRole('heading', { name: 'v2 API beta', exact: true })).toBeVisible();
        await expect(drawer).not.toContainText('End of full project description.');
        await visitor.keyboard.press('Escape');
      }
    } finally {
      await context.close();
    }
  });

  test('public roadmap initially scrolls around today regardless of milestone dates', async ({ appPage: page, browser }) => {
    const ids = await page.locator('.milestone').evaluateAll(elements => elements.map(el => el.dataset.milestoneId));
    const past = new Date();
    past.setUTCDate(past.getUTCDate() - 90);
    const href = await enableRoadmap(page);
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      for (const state of ['future-only', 'mixed', 'past-only', 'empty']) {
        if (state === 'mixed') {
          expect(await postForm(page, `/milestones/${ids[0]}/update/`, { task_id: '0' })).toBe(200);
          expect(await postForm(page, `/milestones/${ids[0]}/update/`, { date: past.toISOString().slice(0, 10) })).toBe(200);
        }
        if (state === 'past-only') expect(await postForm(page, `/milestones/${ids[1]}/delete/`, {})).toBe(200);
        if (state === 'empty') expect(await postForm(page, `/milestones/${ids[0]}/delete/`, {})).toBe(200);
        for (const width of [1280, 390]) {
          await visitor.setViewportSize({ width, height: 844 });
          await visitor.goto(href);
          const chart = visitor.locator('[data-roadmap-chart]');
          await expect(chart).toBeVisible();
          const position = await chart.evaluate(el => {
            const label = el.querySelector('.roadmap-project-label').getBoundingClientRect();
            const today = el.querySelector('.roadmap-today-line');
            const available = el.clientWidth - label.width;
            const expected = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, today.offsetLeft - available / 2));
            return { actual: el.scrollLeft, expected, todayX: today.getBoundingClientRect().left,
              left: label.right, right: el.getBoundingClientRect().right };
          });
          expect(Math.abs(position.actual - position.expected), `${state} at ${width}px`).toBeLessThanOrEqual(1);
          expect(position.todayX).toBeGreaterThan(position.left);
          expect(position.todayX).toBeLessThan(position.right);
        }
      }
    } finally {
      await context.close();
    }
  });

  test('public roadmap includes past standalone and task-linked milestones within the timeline', async ({ appPage: page, browser }) => {
    const spike = page.locator('.bar', { hasText: 'Spike on auth changes' });
    const taskId = await spike.getAttribute('data-task-id');
    const linkedDate = await spike.getAttribute('data-end');
    const linkedId = await page.locator('.milestone[data-title="v2 API beta"]').getAttribute('data-milestone-id');
    const futureId = await page.locator('.milestone[data-title="Soft launch"]').getAttribute('data-milestone-id');
    const projectId = await page.locator('.left-cell.proj', { hasText: 'Infra hardening' }).getAttribute('data-project-id');
    const past = new Date(`${linkedDate}T12:00:00Z`);
    past.setUTCDate(past.getUTCDate() - 90);
    const pastDate = past.toISOString().slice(0, 10);
    expect(await postForm(page, `/milestones/${linkedId}/update/`, { task_id: '0', title: 'Past linked checkpoint' })).toBe(200);
    expect(await postForm(page, `/milestones/${linkedId}/update/`, { date: linkedDate, task_id: taskId })).toBe(200);
    expect(await postForm(page, `/projects/${projectId}/milestones/`, { date: pastDate })).toBe(200);
    await page.reload();
    await expect(page.locator(`#ms-${linkedId}`)).toHaveAttribute('data-date', linkedDate);
    await expect(page.locator(`#ms-${linkedId}`)).toHaveAttribute('data-task-id', taskId);
    const standaloneId = await page.locator('.milestone[data-title="New milestone"]').getAttribute('data-milestone-id');
    expect(await postForm(page, `/milestones/${standaloneId}/update/`, {
      title: 'Already shipped checkpoint', description: 'Historical release details.',
    })).toBe(200);
    const href = await enableRoadmap(page);
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      for (const pastOnly of [false, true]) {
        if (pastOnly) expect(await postForm(page, `/milestones/${futureId}/delete/`, {})).toBe(200);
        for (const width of [1280, 390]) {
          await visitor.setViewportSize({ width, height: 844 });
          await visitor.goto(href);
          const markers = visitor.locator('[data-roadmap-milestone]');
          await expect(markers).toHaveCount(pastOnly ? 2 : 3);
          await expect(visitor.getByRole('heading', { name: 'No public milestones yet', exact: true })).toHaveCount(0);
          const linked = visitor.getByRole('button', { name: /Past linked checkpoint/ });
          await expect(linked).toHaveAttribute('data-date', linkedDate);
          await expect(linked).toHaveAttribute('title', /2 days ago/);
          const historical = visitor.getByRole('button', { name: /Already shipped checkpoint/ });
          await expect(historical).toHaveAttribute('data-date', pastDate);
          // Historical markers must lie inside the scrollable track, not at
          // negative coordinates hidden behind the sticky project labels.
          expect(await markers.evaluateAll(elements => elements.every(el =>
            el.offsetLeft >= 12 && el.offsetLeft + el.offsetWidth <= el.parentElement.clientWidth
          ))).toBe(true);
          await historical.scrollIntoViewIfNeeded();
          await historical.click();
          const drawer = visitor.locator('#drawer');
          await expect(drawer.getByRole('heading', { name: 'Already shipped checkpoint', exact: true })).toBeVisible();
          await expect(drawer).toContainText('Historical release details.');
          await expect(drawer.locator('form, input, textarea, select')).toHaveCount(0);
          await visitor.keyboard.press('Escape');
          await linked.scrollIntoViewIfNeeded();
          await linked.click();
          await expect(drawer.getByRole('heading', { name: 'Past linked checkpoint', exact: true })).toBeVisible();
          await visitor.keyboard.press('Escape');
        }
      }
    } finally {
      await context.close();
    }
  });

  test('public roadmap shows a milestone-only project timeline with read-only details', async ({ appPage: page, browser }) => {
    const href = await enableRoadmap(page);
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      await visitor.goto(href);
      await expect(visitor.locator('[data-roadmap-chart]')).toBeVisible();
      await expect(visitor.locator('[data-roadmap-project-row]')).toHaveCount(3);
      await expect(visitor.locator('[data-roadmap-milestone]')).toHaveCount(2);
      await expect(visitor.locator('.axis-day.today')).toHaveCount(1);
      await expect(visitor.locator('.bar, [data-task-id], [data-creation-type]')).toHaveCount(0);
      const milestone = visitor.getByRole('button', { name: /v2 API beta/ });
      await milestone.scrollIntoViewIfNeeded();
      await milestone.click();
      const drawer = visitor.locator('#drawer');
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('heading', { name: 'v2 API beta' })).toBeVisible();
      await expect(drawer).toContainText('v2 API beta readiness checkpoint.');
      await expect(drawer.locator('input, textarea, select, form')).toHaveCount(0);
      await expect(drawer.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
      await expect(drawer.locator('[data-milestone-history]')).toContainText('No activity yet.');
      await expect(drawer).not.toContainText('Alex Chen');
      await visitor.keyboard.press('Escape');
      await expect(drawer).not.toBeVisible();
      await milestone.focus();
      await visitor.keyboard.press('Enter');
      await expect(drawer).toBeVisible();
      await drawer.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(drawer).not.toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('public milestone sidebar shows ordered history and movement reasons without private task details', async ({ appPage: page, browser }) => {
    const milestone = page.locator('.milestone[data-task-id]').first();
    const id = await milestone.getAttribute('data-milestone-id');
    const before = await milestone.getAttribute('data-date');
    const next = new Date(before);
    next.setUTCDate(next.getUTCDate() + 3);
    const after = next.toISOString().slice(0, 10);
    expect(await postForm(page, `/milestones/${id}/move/`, { date: after, reason: 'Waiting for partner approval' })).toBe(200);
    // Disconnecting also records the private linked-task title in the audit log.
    expect(await postForm(page, `/milestones/${id}/update/`, {
      title: 'Public beta checkpoint', description: 'Updated public description.', task_id: '0', require_move_reason: 'on',
    })).toBe(200);
    const href = await enableRoadmap(page);
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      for (const width of [1280, 390]) {
        await visitor.setViewportSize({ width, height: 844 });
        await visitor.goto(href);
        const marker = visitor.getByRole('button', { name: /Public beta checkpoint/ });
        await marker.scrollIntoViewIfNeeded();
        await marker.click();
        const history = visitor.locator('#drawer [data-milestone-history]');
        await expect(history).toBeVisible();
        await expect(history.locator('li[data-action]')).toHaveCount(2);
        await expect(history.locator('li[data-action]').first()).toHaveAttribute('data-action', 'milestone.updated');
        await expect(history.locator('li[data-action]').last()).toHaveAttribute('data-action', 'milestone.moved');
        await expect(history).toContainText('v2 API beta → Public beta checkpoint');
        await expect(history).toContainText('Description');
        await expect(history).toContainText('Waiting for partner approval');
        await expect(history).toContainText(`${germanNumericDate(before)} → ${germanNumericDate(after)}`);
        await expect(history.locator('time')).toHaveCount(2);
        await expect(history.locator('time').first()).toHaveText(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
        await expect(marker).toHaveAttribute('data-date', after);
        await expect(marker).toHaveAttribute('title', new RegExp(germanNumericDate(after).replaceAll('.', '\\.')));
        await expect(history).not.toContainText('Cutover and deprecation');
        await expect(history).not.toContainText('Require move reason');
        await expect(history).not.toContainText('demo');
        await expect(visitor.locator('#drawer input, #drawer textarea, #drawer select, #drawer form')).toHaveCount(0);
        await visitor.keyboard.press('Escape');
        const other = visitor.getByRole('button', { name: /Soft launch/ });
        await other.scrollIntoViewIfNeeded();
        await other.click();
        await expect(history).toContainText('No activity yet.');
        await expect(history).not.toContainText('Waiting for partner approval');
      }
    } finally {
      await context.close();
    }
  });

  test('public milestone history includes task-driven date changes', async ({ appPage: page, browser }) => {
    const milestone = page.locator('.milestone[data-task-id]').first();
    const taskId = await milestone.getAttribute('data-task-id');
    const before = await milestone.getAttribute('data-date');
    const next = new Date(before);
    next.setUTCDate(next.getUTCDate() + 5);
    const after = next.toISOString().slice(0, 10);
    expect(await postForm(page, `/tasks/${taskId}/resize/end/`, { end: after })).toBe(200);
    const href = await enableRoadmap(page);
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      await visitor.goto(href);
      const marker = visitor.getByRole('button', { name: /v2 API beta/ });
      await marker.scrollIntoViewIfNeeded();
      await marker.click();
      const history = visitor.locator('#drawer [data-milestone-history]');
      await expect(history).toContainText(`${germanNumericDate(before)} → ${germanNumericDate(after)}`);
      await expect(history.locator('[data-action="milestone.moved"]')).toHaveCount(1);
      await expect(history).not.toContainText('Cutover and deprecation');
    } finally {
      await context.close();
    }
  });

  test('milestone sidebar shows its own history including movement reasons', async ({ appPage: page }) => {
    const milestone = page.locator('.milestone').first();
    const id = await milestone.getAttribute('data-milestone-id');
    const before = await milestone.getAttribute('data-date');
    const next = new Date(before);
    next.setDate(next.getDate() + 3);
    const after = next.toISOString().slice(0, 10);
    expect(await postForm(page, `/milestones/${id}/move/`, { date: after, reason: 'Waiting for partner approval' })).toBe(200);
    await page.reload();
    await page.locator(`#ms-${id}`).scrollIntoViewIfNeeded();
    await page.locator(`#ms-${id}`).click();
    const history = page.locator('[data-milestone-history]');
    await expect(history).toBeVisible();
    await expect(history).toContainText('Waiting for partner approval');
    await expect(history.locator('[data-action="milestone.moved"]')).toHaveCount(1);
    await expect(history).toContainText(`${germanNumericDate(before)} → ${germanNumericDate(after)}`);
    await expect(history).toContainText('demo');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const other = page.locator(`.milestone:not(#ms-${id})`).first();
    await other.scrollIntoViewIfNeeded();
    await other.click();
    await expect(page.locator('[data-milestone-history]')).not.toContainText('Waiting for partner approval');
  });

  test('milestone history records date changes driven by its linked task', async ({ appPage: page }) => {
    const milestone = page.locator('.milestone[data-task-id]').first();
    const id = await milestone.getAttribute('data-milestone-id');
    const taskId = await milestone.getAttribute('data-task-id');
    const before = await milestone.getAttribute('data-date');
    const next = new Date(before);
    next.setDate(next.getDate() + 5);
    const after = next.toISOString().slice(0, 10);
    expect(await postForm(page, `/tasks/${taskId}/resize/end/`, { end: after })).toBe(200);
    await page.reload();
    await expect(page.locator(`#ms-${id}`)).toHaveAttribute('data-date', after);
    await page.locator(`#ms-${id}`).scrollIntoViewIfNeeded();
    await page.locator(`#ms-${id}`).click();
    await expect(page.locator('[data-milestone-history]')).toContainText(`${germanNumericDate(before)} → ${germanNumericDate(after)}`);
    await expect(page.locator('[data-milestone-history]')).toContainText('demo');
    await expect(page.locator('[data-milestone-history] [data-action="milestone.moved"]')).toHaveCount(1);
  });

  test('dragging empty roadmap timeline space pans dates and the page with grab cursors', async ({ appPage: page }) => {
    // Ensure page overflow independently of the compact description-free rows.
    for (let i = 0; i < 4; i++) {
      await page.locator('.add-project-row').last().click();
      await expect(page.locator('.left-cell.proj')).toHaveCount(4 + i);
      const projectId = await page.locator('.left-cell.proj').last().getAttribute('data-project-id');
      expect(await postForm(page, `/projects/${projectId}/update/`, { name: `Extra project ${i + 1}`, public_roadmap_visible: 'true' })).toBe(200);
    }
    const href = await enableRoadmap(page);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 360 });
      await page.goto(href);
      const chart = page.locator('[data-roadmap-chart]');
      const track = chart.locator('.roadmap-project-track').first();
      await expect(track).toHaveCSS('cursor', 'grab');
      const start = await chart.evaluate(el => {
        el.scrollLeft = 100;
        window.scrollTo(0, 180);
        return { left: el.scrollLeft, top: window.scrollY };
      });
      const box = await track.boundingBox();
      const x = width - 70;
      const y = Math.min(320, box.y + 60);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await expect(track).toHaveCSS('cursor', 'grabbing');
      await page.mouse.move(x - 80, y - 60, { steps: 8 });
      await expect.poll(() => chart.evaluate(el => el.scrollLeft)).toBe(start.left + 80);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(start.top + 60);
      expect(await chart.evaluate(el => el.scrollTop)).toBe(0);
      await page.mouse.up();
      await expect(track).toHaveCSS('cursor', 'grab');
      // An interrupted drag must not leave a grabbing cursor or active listeners.
      await page.mouse.down();
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await expect(track).toHaveCSS('cursor', 'grab');
      await page.mouse.up();
    }
  });

  test('public roadmap scrolls vertically with the page instead of inside the timeline', async ({ appPage: page }) => {
    const projectId = await page.locator('.left-cell.proj').first().getAttribute('data-project-id');
    expect(await postForm(page, `/projects/${projectId}/update/`, {
      description: Array.from({ length: 24 }, (_, i) => `Project detail ${i + 1}`).join('\n'),
    })).toBe(200);
    const href = await enableRoadmap(page);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 360 });
      await page.goto(href);
      const chart = page.locator('[data-roadmap-chart]');
      await expect(chart).toBeVisible();
      // The chart expands to its content rather than capping its height.
      await expect.poll(() => chart.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
      const box = await chart.boundingBox();
      await page.mouse.move(width - 40, box.y + 80);
      await page.mouse.wheel(0, 300);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      expect(await chart.evaluate(el => el.scrollTop)).toBe(0);
      // Only the wide date axis retains its own scrolling.
      await chart.evaluate(el => { el.scrollLeft = 100; });
      expect(await chart.evaluate(el => el.scrollLeft)).toBe(100);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });

  test('ordinary project members cannot change public roadmap visibility', async ({ appPage: page }) => {
    const id = await page.locator('.left-cell.proj', { hasText: 'API Migration' }).getAttribute('data-project-id');
    expect(await postForm(page, `/projects/${id}/update/`, { public_roadmap_visible: 'false' })).toBe(200);
    const href = await enableRoadmap(page);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.fill('input[name=username]', 'member1');
    await page.fill('input[name=password]', 'member1');
    await page.click('button[type=submit]');
    await page.waitForURL('/');
    await page.locator(`.left-cell.proj[data-project-id="${id}"]`).click();
    await expect(page.locator('#project-popover')).toBeVisible();
    await expect(page.locator('#project-popover').getByLabel('Visible in public roadmap', { exact: true })).toHaveCount(0);
    expect(await postForm(page, `/projects/${id}/update/`, { public_roadmap_visible: 'true' })).toBe(200);
    expect(await postForm(page, `/projects/${id}/`, { name: 'API Migration', color: '#3b82f6', public_roadmap_visible: 'true' })).toBe(403);
    const response = await page.request.get(href);
    expect(response.status()).toBe(200);
    expect(await response.text()).not.toContain('API Migration');
  });

  test('project roadmap visibility migration publishes existing projects but not new ones', async ({ appPage }) => {
    const result = JSON.parse(await notificationDB(`
from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from data.models import Project
try:
    call_command('migrate', 'data', '0034', interactive=False, verbosity=0)
    legacy = MigrationExecutor(connection).loader.project_state([('data', '0034_mcp_oauth_grants')]).apps
    LegacyProject = legacy.get_model('data', 'Project')
    existing_ids = list(LegacyProject.objects.values_list('id', flat=True))
finally:
    call_command('migrate', 'data', interactive=False, verbosity=0)
new_project = Project.objects.create(workspace_id=Project.objects.first().workspace_id, name='Private after migration')
print(json.dumps({'existing': list(Project.objects.filter(id__in=existing_ids).values_list('public_roadmap_visible', flat=True)), 'new': new_project.public_roadmap_visible}))
`));
    expect(result).toEqual({ existing: [true, true, true], new: false });
  });

  test('new projects stay private after renaming until explicitly published in the drawer', async ({ appPage: page, browser }) => {
    await page.locator('.add-project-row').last().click();
    await expect(page.locator('.left-cell.proj')).toHaveCount(4);
    const project = page.locator('.left-cell.proj').last();
    const id = await project.getAttribute('data-project-id');
    expect(await postForm(page, `/projects/${id}/update/`, { name: 'Private launch' })).toBe(200);
    const href = await enableRoadmap(page);
    const context = await browser.newContext();
    try {
      const visitor = await context.newPage();
      await visitor.goto(href);
      await expect(visitor.locator('.roadmap-project-label').filter({ hasText: 'Private launch' })).toHaveCount(0);
      expect(await postForm(visitor, `${href}projects/${id}/follow/`, { action: 'follow', teams_email: 'visitor@example.com' })).toBe(404);

      await page.goto('/');
      await page.locator(`.left-cell.proj[data-project-id="${id}"]`).click();
      const visibility = page.locator('#project-popover').getByLabel('Visible in public roadmap', { exact: true });
      await expect(visibility).not.toBeChecked();
      await visibility.check();
      await page.locator('#project-popover').getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('#project-popover')).toHaveCount(0);
      await page.reload();
      await page.locator(`.left-cell.proj[data-project-id="${id}"]`).click();
      await expect(visibility).toBeChecked();
      await visitor.reload();
      await expect(visitor.locator('.roadmap-project-label').filter({ hasText: 'Private launch' })).toHaveCount(1);
      await visibility.uncheck();
      await page.locator('#project-popover').getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('#project-popover')).toHaveCount(0);
      await visitor.reload();
      await expect(visitor.locator('.roadmap-project-label').filter({ hasText: 'Private launch' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('project detail visibility setting hides and restores project milestones and descriptions', async ({ appPage: page, browser }) => {
    const milestone = page.locator('.chart-row.proj .milestone').first();
    const id = await milestone.getAttribute('data-project-id');
    const title = await milestone.getAttribute('data-title');
    expect(await postForm(page, `/projects/${id}/update/`, { description: 'Confidential launch notes' })).toBe(200);
    const href = await enableRoadmap(page);
    const context = await browser.newContext();
    try {
      const visitor = await context.newPage();
      await visitor.goto(href);
      expect(await visitor.content()).toContain(title);
      await page.goto(`/projects/${id}/`);
      await page.getByText('Edit project', { exact: true }).click();
      const editor = page.locator('#project-detail-editor');
      const visibility = editor.getByLabel('Visible in public roadmap', { exact: true });
      await expect(visibility).toBeChecked();
      await visibility.uncheck();
      await editor.getByRole('button', { name: 'Save project', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('Project saved.');
      await visitor.reload();
      await expect(visitor.locator('.roadmap-project-label')).toHaveCount(2);
      expect(await visitor.content()).not.toContain(title);
      expect(await visitor.content()).not.toContain('Confidential launch notes');
      expect(await postForm(visitor, `${href}projects/${id}/follow/`, { action: 'follow', teams_email: 'visitor@example.com' })).toBe(404);

      await page.reload();
      await page.getByText('Edit project', { exact: true }).click();
      await expect(visibility).not.toBeChecked();
      await visibility.check();
      await editor.getByRole('button', { name: 'Save project', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('Project saved.');
      await visitor.reload();
      await expect(visitor.locator('.roadmap-project-label')).toHaveCount(3);
      expect(await visitor.content()).toContain(title);
    } finally {
      await context.close();
    }
  });

  test('public roadmap hides default-named projects and their milestones until renamed', async ({ appPage: page, browser }) => {
    const milestone = page.locator('.chart-row.proj .milestone').first();
    const projectId = await milestone.getAttribute('data-project-id');
    const milestoneTitle = await milestone.getAttribute('data-title');
    await page.locator('.add-project-row').last().click();
    await expect(page.locator('.left-cell.proj')).toHaveCount(4);
    const emptyProjectId = await page.locator('.left-cell.proj').last().getAttribute('data-project-id');
    expect(await postForm(page, `/projects/${projectId}/update/`, {
      name: 'New project', description: 'Unpublished placeholder description',
    })).toBe(200);
    const href = await enableRoadmap(page);
    const context = await browser.newContext();
    try {
      const visitor = await context.newPage();
      await visitor.goto(href);
      await expect(visitor.locator('.roadmap-project-label')).toHaveCount(2);
      await expect(visitor.getByRole('heading', { name: 'New project', exact: true })).toHaveCount(0);
      expect(await visitor.content()).not.toContain(milestoneTitle);
      expect(await visitor.content()).not.toContain('Unpublished placeholder description');

      // Named projects without milestones remain public; similarly named projects are not filtered.
      expect(await postForm(page, `/projects/${emptyProjectId}/update/`, { name: 'Published empty project', public_roadmap_visible: 'true' })).toBe(200);
      expect(await postForm(page, `/projects/${projectId}/update/`, { name: 'New project launch' })).toBe(200);
      await visitor.reload();
      await expect(visitor.locator('.roadmap-project-label')).toHaveCount(4);
      await expect(visitor.getByRole('heading', { name: 'Published empty project', exact: true })).toBeVisible();
      await expect(visitor.getByRole('heading', { name: 'New project launch', exact: true })).toBeVisible();
      expect(await visitor.content()).toContain(milestoneTitle);

      expect(await postForm(page, `/projects/${projectId}/update/`, { name: 'New project' })).toBe(200);
      await visitor.reload();
      await expect(visitor.locator('.roadmap-project-label')).toHaveCount(3);
      expect(await visitor.content()).not.toContain(milestoneTitle);
      await page.goto('/');
      await expect(page.locator(`.left-cell.proj[data-project-id="${projectId}"]`)).toContainText('New project');
    } finally {
      await context.close();
    }
  });

  test('public roadmap keeps project descriptions and following available without milestones', async ({ appPage: page }) => {
    const ids = await page.locator('.milestone').evaluateAll(elements => elements.map(el => el.dataset.milestoneId));
    for (const id of ids) expect(await postForm(page, `/milestones/${id}/delete/`, {})).toBe(200);
    const href = await enableRoadmap(page);
    await page.goto(href);
    await expect(page.getByRole('heading', { name: 'No public milestones yet', exact: true })).toBeVisible();
    const labels = page.locator('.roadmap-project-label');
    await expect(labels).toHaveCount(3);
    const project = labels.filter({ hasText: 'API Migration' });
    await expect(project).not.toContainText('Move public API traffic to the new v2 platform.');
    await project.getByRole('button', { name: 'API Migration', exact: true }).click();
    await expect(page.locator('#drawer')).toContainText('Move public API traffic to the new v2 platform.');
    await page.keyboard.press('Escape');
    await project.getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(project.getByRole('button', { name: 'Subscribed', exact: true })).toBeVisible();
  });

  test('regenerating the public roadmap link revokes the old URL', async ({ appPage: page, request }) => {
    const oldHref = await enableRoadmap(page);
    await page.getByRole('button', { name: 'Regenerate public link' }).click();
    await page.waitForURL('/workspaces/settings/sharing/');

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
    const moveButton = page.getByRole('button', { name: 'Move to workspace', exact: true });
    const destination = page.locator('#project-move-workspace');
    const confirm = page.locator('#project-popover').getByRole('button', { name: 'Confirm', exact: true });
    const cancel = page.locator('#project-popover').getByRole('button', { name: 'Cancel', exact: true });
    await expect(moveButton).toBeVisible();
    await expect(destination).toBeHidden();
    await expect(confirm).toBeHidden();
    await expect(cancel).toBeHidden();

    await moveButton.click();
    await expect(destination).toBeVisible();
    await expect(destination).toBeFocused();
    await expect(confirm).toBeVisible();
    await expect(cancel).toBeVisible();
    await destination.selectOption({ label: 'Side project' });

    // Cancel closes only the move controls and keeps the editor and project intact.
    await cancel.click();
    await expect(destination).toBeHidden();
    await expect(confirm).toBeHidden();
    await expect(cancel).toBeHidden();
    await expect(moveButton).toBeFocused();
    await expect(page.locator('#project-popover')).toBeVisible();
    await expect(page.locator('.left-cell.proj', { hasText: 'API Migration' })).toBeVisible();

    // Inline confirmation moves the project without an additional browser dialog.
    await moveButton.click();
    await destination.selectOption({ label: 'Side project' });
    await confirm.click();
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

  test('member can assign an unowned project to themselves', async ({ page, request }) => {
    await reset(request);
    await loginAsMember(page);

    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    const assignMe = page.getByRole('button', { name: 'Assign to me' });
    await expect(assignMe).toBeVisible();
    await assignMe.click();
    await expect(assignMe).toBeHidden();
    const pill = page.locator('#project-responsible-pills .project-responsible-pill:visible');
    await expect(pill).toHaveCount(1);
    await expect(pill).toContainText('Alex Chen');
    await expect(pill.getByRole('button', { name: 'Remove Alex Chen' }).locator('svg')).toHaveCount(1);

    await page.click('#project-popover button[type=submit]');
    await expect(page.locator('#project-popover')).toHaveCount(0);
    await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
    await expect(page.locator('#project-responsible-pills .project-responsible-pill:visible')).toContainText('Alex Chen');
    await expect(page.locator('#project-popover button', { hasText: 'Delete project' })).toBeVisible();
  });

  test('member cannot configure milestone move explanations', async ({ page, request }) => {
    await reset(request);
    await loginAsMember(page);

    const milestone = page.locator('.milestone').first();
    const milestoneId = await milestone.getAttribute('data-milestone-id');
    const milestoneDate = await milestone.getAttribute('data-date');
    await milestone.scrollIntoViewIfNeeded();
    const box = await milestone.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('#milestone-popover')).toBeVisible();
    await expect(page.locator('input[name=require_move_reason]')).toHaveCount(0);

    await page.evaluate(async ({ id, date }) => {
      const token = document.cookie.split('; ').find((row) => row.startsWith('csrftoken='))?.split('=')[1] || '';
      await fetch(`/milestones/${id}/update/`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': decodeURIComponent(token),
        },
        body: new URLSearchParams({ date, require_move_reason: 'true' }),
      });
    }, { id: milestoneId, date: milestoneDate });

    await page.reload();
    await expect(page.locator(`#ms-${milestoneId}`)).toHaveAttribute('data-requires-move-reason', 'false');
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

  test('member can assign an unowned task to themselves', async ({ page, request }) => {
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

    const assignMe = page.getByRole('button', { name: 'Assign to me' });
    await expect(assignMe).toBeVisible();
    await assignMe.click();
    await expect(assignMe).toBeHidden();
    const pill = page.locator('#task-assignee-pills .task-assignee-pill:visible');
    await expect(pill).toContainText('Alex Chen');
    await expect(pill.getByRole('button', { name: 'Remove Alex Chen' }).locator('svg')).toHaveCount(1);

    await page.fill('#task-popover input[name=title]', 'Unassigned task updated by member');
    await page.click('#task-popover button[type=submit]');
    await expect(page.locator('#task-popover')).toHaveCount(0);
    const updatedTask = page.locator('.bar', { hasText: 'Unassigned task updated by member' });
    await expect(updatedTask).toBeVisible();
    await updatedTask.click();
    await expect(page.locator('#task-assignee-pills .task-assignee-pill:visible')).toContainText('Alex Chen');
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
  test('My Profile menu item opens the profile and highlights the active page', async ({ appPage: page }) => {
    const menu = page.locator('.drawer-side .menu');
    const profile = menu.getByRole('link', { name: 'My Profile', exact: true });
    await expect(profile).toBeVisible();
    await expect(profile).toHaveAttribute('href', '/profile/');
    await profile.click();
    await page.waitForURL('/profile/');
    await expect(profile).toHaveClass(/menu-active/);
    await expect(page.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible();
    await page.locator('.lang-btn', { hasText: 'DE' }).click();
    await expect(menu.getByRole('link', { name: 'Mein Profil', exact: true })).toHaveClass(/menu-active/);
  });

  test('sidebar shell precedes the page content in document order', async ({ appPage: page }) => {
    const sidebarBeforeContent = await page.locator('.drawer').evaluate((drawer) => {
      const sidebar = drawer.querySelector(':scope > .drawer-side');
      const content = drawer.querySelector(':scope > .drawer-content');
      return Boolean(sidebar.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING);
    });

    expect(sidebarBeforeContent).toBe(true);
  });

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
    await expect(workspaceMenu.getByRole('link', { name: 'Workspace settings', exact: true })).toHaveCSS('font-size', '16px');

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
    await expect(page.locator('.people-page-header')).toContainText('Teammitglieder, die du Aufgaben zuweisen kannst.');

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

  for (const [kind, selector] of [
    ['task', '.bar:has-text("Migrate /users endpoints")'],
    ['milestone', '.chart-row.proj .milestone'],
    ['project', '.left-cell.proj:has-text("API Migration")'],
  ]) {
    test(`${kind} save button says Speichern in German`, async ({ appPage: page }) => {
      await page.locator('.lang-btn', { hasText: 'DE' }).click();
      await expect(page.locator('.lang-btn', { hasText: 'DE' })).toHaveClass(/active/);
      await page.locator(selector).first().click();
      await expect(page.locator(`#${kind}-popover button[type=submit]`)).toHaveText('Speichern');
    });
  }

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
    await expect(page.locator('.login-card .hint').first()).toHaveText('Melde dich bei deinen Projekten an.');
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
    await expect(page.locator('label[for="project-responsible-people"]')).toHaveText('Verantwortliche');
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
