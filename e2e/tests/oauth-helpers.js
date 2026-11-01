const { randomBytes, createHash } = require('crypto');
const { expect } = require('./fixtures');

async function start(page, baseURL, { scope = 'core.read core.write', resource = `${baseURL}/mcp`, redirect = `${baseURL}/healthz`, name = 'Test assistant' } = {}) {
  const registered = await page.request.post('/oauth/register', { data: { client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none' } });
  expect(registered.status(), await registered.text()).toBe(201);
  const client = await registered.json();
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, resource, state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  if (scope !== null) params.set('scope', scope);
  const url = `${baseURL}/oauth/authorize?${params}`;
  const exchange = (code, extra = {}) => page.request.post('/oauth/token', { form: { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: redirect, resource, ...extra } });
  const refresh = (token, extra = {}) => page.request.post('/oauth/token', { form: { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token, resource, ...extra } });
  const revoke = token => page.request.post('/oauth/revoke', { form: { client_id: client.client_id, token } });
  const rpc = (token, name, args = {}) => page.request.post('/mcp', { headers: { Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  const call = async (token, name, args = {}) => {
    const response = await rpc(token, name, args);
    expect(response.status(), await response.text()).toBe(200);
    const body = await response.json();
    expect(body.error, JSON.stringify(body)).toBeUndefined();
    expect(body.result.isError, JSON.stringify(body)).not.toBe(true);
    return body.result.structuredContent;
  };
  return { ...client, url, verifier, state, resource, redirect, exchange, refresh, revoke, rpc, call };
}

async function decide(page, flow, { workspaces = [], caps = ['core.read', 'core.write'], decision = 'allow' } = {}) {
  await page.goto(flow.url);
  await expect(page.getByRole('heading', { name: 'Connect an assistant' })).toBeVisible();
  for (const checkbox of await page.locator('input[name="workspace"], input[name="capability"]').all()) await checkbox.uncheck();
  for (const id of workspaces) await page.locator(`input[name="workspace"][value="${id}"]`).check();
  for (const cap of caps) await page.locator(`input[name="capability"][value="${cap}"]`).check();
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === flow.url && response.request().method() === 'POST'),
    page.getByRole('button', { name: decision === 'allow' ? 'Allow access' : 'Deny', exact: true }).click(),
  ]);
  expect(response.status()).toBe(302);
  await page.waitForURL(url => url.origin + url.pathname === flow.redirect);
  const callback = new URL(page.url());
  expect(callback.searchParams.get('state')).toBe(flow.state);
  return callback.searchParams;
}

module.exports = { start, decide };
