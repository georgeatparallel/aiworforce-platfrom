// THE PARTS OF `tasks.result` THE BROWSER RECEIVES — ONE TABLE, BOTH DIRECTIONS.
//
// `tasks.result` is mostly the engine's resume state (`lead_resume_checkpoint`
// alone was 626 kB of the 890 kB five tasks weighed on the wire), and the task
// list is read on mount, on every realtime event and on a 4-second heartbeat.
// So the list read projects named result keys server-side and rebuilds the
// nested `result` the components read. See `fetchTasksForPlan`.
//
// ── WHY THIS IS A TABLE ─────────────────────────────────────────────────────
//
// The column list and the rebuild used to be two hand-written lists. Canary
// 9b1b70a2 (2026-09-19): the backend wrote the canonical Lead V2 decision to
// `result.workbench_mission_view`, every Workbench reader preferred it — and
// neither list named it. The readers got null, fell back to the legacy rows,
// and the Workbench put the one qualified lead and a verified FAIL under "Not
// reached". Every reader test passed, because each fed the full stored result.
//
// One entry here produces both the PostgREST column and the path it is rebuilt
// at, so a key can no longer be requested without being rebuilt, or read
// without being requested. Tests drive `projectTaskListRow` with a real stored
// result through `TASK_LIST_COLUMNS`, the same path the browser takes.
//
// Pure — no client, no network.

export interface TaskResultField {
  /** PostgREST alias the value comes back under. */
  alias: string;
  /** Where the value lives in `tasks.result`, and where it is rebuilt. */
  path: readonly string[];
  /** Who reads it. A field nobody reads does not belong here. */
  reader: string;
}

export const TASK_RESULT_FIELDS: readonly TaskResultField[] = [
  { alias: 'r_task_status', path: ['task_status'], reader: 'chat/state taskResultIsPartial' },
  { alias: 'r_terminal_status', path: ['terminal_status'], reader: 'chat/state taskResultIsPartial' },
  { alias: 'r_continuation_owner', path: ['continuation_owner'], reader: 'chat/state taskQueueContinuing' },
  { alias: 'r_quota', path: ['quota'], reader: 'chat/state taskQuotaUnmet' },
  { alias: 'r_company_first', path: ['company_first'], reader: 'SummaryView, taskCompanyFirst, taskQuotaUnmet' },
  { alias: 'r_workbench_progress', path: ['workbench_progress'], reader: 'workbench/workbenchProgress' },
  { alias: 'r_workbench_evaluation_rows', path: ['workbench_evaluation_rows'], reader: 'workbench/evaluationRows (legacy runs)' },
  { alias: 'r_workbench_portfolio', path: ['workbench_portfolio'], reader: 'workbench/portfolioView' },
  // Lead V2: the canonical decision. Every Workbench number and tab reads it
  // first; without it they silently fall back to the legacy rows.
  { alias: 'r_workbench_mission_view', path: ['workbench_mission_view'], reader: 'workbench/missionView' },
  // Narrowed to the one field their reader touches: the parents are the
  // engine's execution state (269 kB) and the full company-first state.
  { alias: 'r_candidate_diagnostics', path: ['company_first_state', 'candidate_diagnostics'], reader: 'readDiagnosticsFromResult' },
  { alias: 'r_provider_attempts', path: ['capability_execution_state', 'provider_attempts'], reader: 'hasStoredCompanyRun' },
];

export const TASK_ROW_COLUMNS: readonly string[] = [
  'id', 'plan_id', 'agent_id', 'agent_slug', 'workspace_id', 'user_id',
  'step_index', 'description', 'status', 'input', 'output', 'payload',
  'error_message', 'started_at', 'finished_at', 'completed_at', 'created_at',
  'checkpoint_version',
];

/** The `select` string for the task list: row columns plus the projected result keys. */
export const TASK_LIST_COLUMNS: string = [
  ...TASK_ROW_COLUMNS,
  ...TASK_RESULT_FIELDS.map((f) => `${f.alias}:result->${f.path.join('->')}`),
].join(',');

/**
 * One PostgREST row back into the task shape the components read.
 *
 * ABSENT, NOT EMPTY. A task with no result stays `null`: `taskResultIsPartial`
 * and `taskQuotaUnmet` return false for a non-object, and a `{}` full of
 * undefined would make a task that never ran look like one that ran and
 * reported nothing.
 */
export function projectTaskListRow(row: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row };
  const values = TASK_RESULT_FIELDS.map((f) => {
    const v = rest[f.alias];
    delete rest[f.alias];
    return [f, v] as const;
  });
  const present = values.some(([, v]) => v !== null && v !== undefined);
  if (!present) return { ...rest, result: null };

  const result: Record<string, unknown> = {};
  for (const [f, v] of values) {
    if (f.path.length === 1) {
      result[f.path[0]] = v ?? undefined;
      continue;
    }
    // A nested field is rebuilt at the path its reader expects, carrying only
    // that field, and only when it came back.
    if (v === null || v === undefined) continue;
    let node = result;
    for (const key of f.path.slice(0, -1)) {
      const next = node[key];
      node = (next && typeof next === 'object' ? next : (node[key] = {})) as Record<string, unknown>;
    }
    node[f.path[f.path.length - 1]] = v;
  }
  result.result_truncated = true;
  return { ...rest, result };
}
