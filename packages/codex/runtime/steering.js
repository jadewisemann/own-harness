/** Codex workspace registration determines which state files are trusted. */
import fs from 'node:fs';
import path from 'node:path';
import * as common from './harness_common.js';
import { readState, executionReason } from './steering-state.js';

const readTools = new Set(['Read', 'Glob', 'Grep', 'read_file', 'list_directory', 'view_image', 'read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates']);
export const task_state = task => readState([common.ROOT, common.safe_path(common.ROOT, 'work', task)]);
export function checkout_state(task, checkout, role = 'integration') {
  const workspaces = [common.ROOT, common.safe_path(common.ROOT, 'work', task)];
  if (role === 'worker') {
    // Legacy workers are themselves the sub workspace; direct workers have a parent workspace.
    const parts = path.relative(common.ROOT, checkout).split(path.sep);
    if (parts[2] === '.sub-workspace') workspaces.push(path.dirname(checkout));
    else if (!common.git(checkout, 'ls-files', '--', 'state.json')) workspaces.push(checkout);
  }
  return readState(workspaces);
}

function registration(task) {
  const data = common.task_registration(common.ROOT, task);
  for (const [repo, entry] of Object.entries(data.repos)) {
    const info = common.checkout_info(entry.checkout, task);
    common.require(info[1] === repo && info[4] === 'integration' && info[3] === entry.branch, '작업의 저장소 등록이 실제 checkout과 다릅니다.');
  }
  return data;
}

function registered(task, info, data = registration(task)) {
  const [, repo, checkout, branch, role] = info;
  const entry = data.repos[repo];
  common.require(entry && (role === 'worker' || (entry.checkout === checkout && entry.branch === branch)), 'checkout이 작업 기록의 등록과 다릅니다.');
  return checkout_state(task, checkout, role);
}

export function state_for(cwd) {
  common.load_config();
  common.require(typeof cwd === 'string' && path.isAbsolute(cwd), 'hook cwd는 절대 경로여야 합니다.');
  const actual = common.resolved_path(cwd);
  const relative = path.relative(common.ROOT, actual).split(path.sep);
  let data;
  if (actual === common.ROOT) return readState([common.ROOT]);
  if (common.contained(actual) && relative[0] === 'work' && common.TASK_RE.test(relative[1] ?? '')) {
    const task = relative[1];
    const file = common.task_work_path(task);
    if (!fs.existsSync(file)) return readState([common.ROOT]); // Unregistered directories never supply state.
    data = registration(task);
    if (relative.length === 2) return task_state(task);
    if (relative.length >= 4 && ['.sub-workspace', '.worktrees'].includes(relative[2])) {
      const worker = common.worker_registration(common.ROOT, task, relative[3]);
      return registered(task, common.checkout_info(worker.checkout, task), data);
    }
    // Evidence and other unregistered task folders inherit only project/task state.
    const entries = [...Object.values(data.repos), ...Object.values(data.workers ?? {})];
    if (!entries.some(entry => typeof entry.checkout === 'string' && common.contained(actual, entry.checkout))) return task_state(task);
  }
  const top = common.git(actual, 'rev-parse', '--show-toplevel', { optional: true });
  if (!top) { common.require(common.contained(actual), '등록된 workspace 밖의 cwd입니다.'); return readState([common.ROOT]); }
  const info = common.checkout_info(actual, null, common.ROOT, true);
  return info[0] ? registered(info[0], info, data) : readState([common.ROOT]);
}

export function require_execution(cwd) {
  const reason = executionReason(state_for(cwd));
  common.require(!reason, reason);
}

export function hook(event, output = {}) {
  const kind = event.hook_event_name;
  if (!['UserPromptSubmit', 'PreToolUse'].includes(kind)) return output;
  let context, reason;
  try { const current = state_for(event.cwd); context = current.context; reason = executionReason(current); }
  catch (error) { context = reason = `작업 상태 검사 실패: ${error.message}`; }
  if (context) {
    const specific = output.hookSpecificOutput ??= { hookEventName: kind };
    specific.additionalContext = [specific.additionalContext, context].filter(Boolean).join('\n');
    if (kind === 'PreToolUse' && reason && !readTools.has(event.tool_name)) {
      specific.permissionDecision = 'deny';
      specific.permissionDecisionReason = reason;
    }
  }
  return output;
}
