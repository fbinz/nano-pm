const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { randomUUID } = require('crypto');
const { expect, djangoEnv } = require('./fixtures');

const capabilities = ['core.read', 'core.write', 'workspace.admin', 'workload.self',
  'workload.manage', 'sharing.links', 'workspace.create'];
const expectedTools = `get_me list_workspaces get_workspace create_workspace update_workspace list_activity get_schedule
list_projects get_project create_project update_project claim_project set_project_completed set_project_phase reorder_projects move_project_to_workspace delete_project
list_tasks get_task create_task update_task claim_task move_task move_tasks delete_task
list_milestones get_milestone create_milestone update_milestone delete_milestone list_dependencies add_dependency delete_dependency
list_people get_person create_person update_person delete_person list_teams create_team update_team delete_team list_memberships set_member_role create_person_invite
get_my_workload submit_my_workload review_my_workload snooze_my_workload_checkin get_workload_overview list_workload_reports get_workload_report get_workload_settings update_workload_settings list_workload_categories create_workload_category update_workload_category delete_workload_category set_workload_participation
get_gitlab_connection list_gitlab_issues get_gitlab_issue get_project_gitlab_binding update_project_gitlab_binding transfer_gitlab_issue request_gitlab_sync update_gitlab_workflow
get_notification_settings update_notification_settings list_notification_deliveries list_my_project_subscriptions set_my_project_subscription get_public_roadmap_settings update_public_roadmap_settings get_public_roadmap_link rotate_public_roadmap_link`.split(/\s+/);

async function db(code) {
  const { stdout } = await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'shell', '-c', `
import json
from datetime import timedelta
from django.utils import timezone
from django.contrib.auth import get_user_model
from django_mcpz.bearer_tokens.models import Token
from data.models import *
${code}
`], { cwd: path.resolve(__dirname, '../..'), env: djangoEnv() });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function setup(page, { user = 'demo', caps = capabilities } = {}) {
  const info = await db(`
u = get_user_model().objects.get(username=${JSON.stringify(user)})
m = Membership.objects.filter(user=u).first()
t, value = Token.create(name='Playwright', user=u, expires_at=timezone.now()+timedelta(days=1))
p = MCPAccessPolicy.objects.create(token=t, capabilities=${JSON.stringify(caps)})
p.workspaces.add(m.workspace)
print(json.dumps({'token':value, 'token_id':t.pk, 'workspace_id':m.workspace_id,
'foreign_workspace_id':Workspace.objects.exclude(pk=m.workspace_id).first().pk}))`);
  const rpc = async (method, params = {}, headers = {}) => page.request.post('/mcp', {
    headers: { Authorization: `Bearer ${info.token}`, Accept: 'application/json, text/event-stream', ...headers },
    data: { jsonrpc: '2.0', id: 1, method, params },
  });
  const raw = async (name, args = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const call = async (name, args = {}) => {
    const body = await raw(name, args);
    expect(body.error, JSON.stringify(body)).toBeUndefined();
    expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
    return body.result.structuredContent;
  };
  const scope = { workspace_id: info.workspace_id };
  const mutate = (name, args = {}) => call(name, { ...scope, operation_id: randomUUID(), ...args });
  return { ...info, scope, rpc, raw, call, mutate };
}

module.exports = { setup, db, expectedTools, randomUUID };
