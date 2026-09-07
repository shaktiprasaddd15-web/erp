const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendPushToEmployees } = require('../utils/push');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const PRIORITIES = ['none', 'low', 'medium', 'high'];

async function projectManagerId(q, projectId) {
  const { rows } = await q.query('SELECT manager_id FROM projects WHERE id = $1', [projectId]);
  return rows[0] ? rows[0].manager_id : null;
}
async function isMember(q, projectId, empId) {
  const { rows } = await q.query(
    'SELECT 1 FROM project_members WHERE project_id = $1 AND employee_id = $2',
    [projectId, empId]
  );
  return rows.length > 0;
}
// Assigning a task to someone adds them to the project (that's how people join a
// project now — no separate member-picking step). Returns true if newly added.
async function ensureMember(q, projectId, empId) {
  const { rowCount } = await q.query(
    `INSERT INTO project_members (project_id, employee_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [projectId, empId]
  );
  return rowCount > 0;
}
// SQL predicate: employee $n is an assignee of task alias `t` (primary or in the
// task_assignees set). Used to scope "my tasks" and project-board visibility.
const assigneeOf = (alias, n) =>
  `(${alias}.assignee_id = $${n} OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = ${alias}.id AND ta.employee_id = $${n}))`;
async function isAssignee(taskId, empId) {
  const { rows } = await db.query(
    `SELECT 1 FROM tasks t WHERE t.id = $1 AND ${assigneeOf('t', 2)}`, [taskId, empId]);
  return rows.length > 0;
}
async function logActivity(q, projectId, actorId, action, detail) {
  try {
    await q.query(
      'INSERT INTO project_activity (project_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
      [projectId, actorId, action, detail]
    );
  } catch (e) { console.error('activity log failed', e.message); }
}

// Columns returned for a task, decorated with owner / assigner names and the
// per-tab counts (subtasks, comments, docs, issues) shown in the task panel.
const TASK_SELECT = `
  SELECT t.id, t.title, t.details, t.status, t.task_date, t.start_date, t.duration,
         t.priority, t.completion, t.tags, t.stipend, t.project_id, t.parent_task_id,
         t.assignee_id, a.name AS assignee_name, a.employee_code AS assignee_code,
         t.assigned_by, e.name AS assigned_by_name,
         p.name AS project_name,
         COALESCE((SELECT json_agg(json_build_object('id', ae.id, 'name', ae.name) ORDER BY ae.name)
                   FROM task_assignees ta JOIN employees ae ON ae.id = ta.employee_id
                   WHERE ta.task_id = t.id), '[]'::json) AS assignees,
         (SELECT COUNT(*)::int FROM tasks s   WHERE s.parent_task_id = t.id) AS subtask_count,
         (SELECT COUNT(*)::int FROM task_submissions u WHERE u.task_id = t.id) AS update_count,
         (SELECT COUNT(*)::int FROM task_comments c WHERE c.task_id = t.id) AS comment_count,
         (SELECT COUNT(*)::int FROM task_docs d   WHERE d.task_id = t.id) AS doc_count,
         (SELECT COUNT(*)::int FROM task_issues i WHERE i.task_id = t.id AND i.status = 'open') AS issue_count
  FROM tasks t
  LEFT JOIN employees a ON a.id = t.assignee_id
  LEFT JOIN employees e ON e.id = t.assigned_by
  LEFT JOIN projects  p ON p.id = t.project_id
`;

// Only admins and HR may see (or set) the stipend flag. Strip it from task
// payloads for everyone else so it never reaches their UI.
function canSeeStipend(user) { return user.accessRole === 'admin' || user.accessRole === 'hr'; }
function scrubStipend(data, user) {
  if (canSeeStipend(user)) return data;
  const strip = (t) => { if (t && typeof t === 'object') delete t.stipend; return t; };
  return Array.isArray(data) ? data.map(strip) : strip(data);
}

// Work updates feed each person's personal report, so they are private to the
// people they belong to. Only the task's own assignees (posting their own work)
// and admin / HR may see or post them — managers, by policy, cannot see other
// people's work updates.
async function canSeeWorkUpdates(taskId, user) {
  if (user.accessRole === 'admin' || user.accessRole === 'hr') return true;
  return await isAssignee(taskId, user.id);
}

// Can this user edit the task's fields? (any assignee, the project's manager, or an admin)
async function canEditTask(task, user) {
  if (user.accessRole === 'admin' || user.accessRole === 'manager') return true;
  if (task.assignee_id === user.id) return true;
  if (await isAssignee(task.id, user.id)) return true;
  const mgr = await projectManagerId(db, task.project_id);
  if (mgr === user.id) return true;
  return false;
}

// GET /api/tasks/mine — the caller's tasks (incl. subtasks). A done task stays
// visible for the rest of the day it was completed, then rolls off the next
// day (so the list shows what's still to do plus today's completions).
router.get('/mine', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    `${TASK_SELECT}
     WHERE ${assigneeOf('t', 1)}
       AND NOT (t.status = 'done' AND t.completed_at IS NOT NULL AND t.completed_at::date < CURRENT_DATE)
     ORDER BY (t.status = 'done'), t.task_date DESC NULLS LAST, t.created_at DESC`,
    [req.user.id]
  );
  res.json({ tasks: scrubStipend(rows, req.user) });
}));

// GET /api/tasks?projectId= — top-level tasks within a project.
// Admins, managers and the project leader see every task; a plain member sees
// only the tasks assigned to them.
router.get('/', requireAuth, wrap(async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'projectId is required.' });
  const mgr = await projectManagerId(db, projectId);
  if (mgr == null) return res.status(404).json({ error: 'Project not found.' });
  // Admins see every project's tasks; a manager only the projects they manage.
  const seesAll = req.user.accessRole === 'admin' || mgr === req.user.id;
  if (!seesAll && !(await isMember(db, projectId, req.user.id))) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const params = [projectId];
  let scope = '';
  if (!seesAll) { params.push(req.user.id); scope = ` AND ${assigneeOf('t', params.length)}`; }
  const { rows } = await db.query(
    `${TASK_SELECT} WHERE t.project_id = $1 AND t.parent_task_id IS NULL${scope}
     ORDER BY (t.status = 'done'), t.created_at`,
    params
  );
  res.json({ tasks: scrubStipend(rows, req.user), canManage: seesAll });
}));

// GET /api/tasks/:id — one task with all its fields (for the task panel).
router.get('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(`${TASK_SELECT} WHERE t.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Task not found.' });
  const task = rows[0];
  const priv = req.user.accessRole === 'manager' || req.user.accessRole === 'admin';
  if (!priv && task.assignee_id !== req.user.id && !(await isMember(db, task.project_id, req.user.id))) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  res.json({ task: scrubStipend(task, req.user) });
}));

// GET /api/tasks/:id/subtasks — the child tasks of a task.
router.get('/:id/subtasks', requireAuth, wrap(async (req, res) => {
  const { rows: t } = await db.query('SELECT project_id, assignee_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!t[0]) return res.status(404).json({ error: 'Task not found.' });
  const priv = req.user.accessRole === 'manager' || req.user.accessRole === 'admin';
  if (!priv && t[0].assignee_id !== req.user.id && !(await isMember(db, t[0].project_id, req.user.id))) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const { rows } = await db.query(
    `${TASK_SELECT} WHERE t.parent_task_id = $1 ORDER BY (t.status = 'done'), t.created_at`,
    [req.params.id]
  );
  res.json({ tasks: scrubStipend(rows, req.user) });
}));

// POST /api/tasks — assign a task (project manager / admin), or add a subtask
// (parentTaskId set: the parent's assignee can also add one). Subtasks inherit
// the parent's project and show up in the assignee's "My Tasks" automatically.
router.post('/', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const parentId = b.parentTaskId ? Number(b.parentTaskId) : null;
  let pid = Number(b.projectId);
  let parent = null;

  if (parentId) {
    const { rows } = await db.query('SELECT id, project_id, assignee_id, title FROM tasks WHERE id = $1', [parentId]);
    parent = rows[0];
    if (!parent) return res.status(404).json({ error: 'Parent task not found.' });
    pid = parent.project_id;
  }
  if (!Number.isInteger(pid)) return res.status(400).json({ error: 'A project is required.' });
  if (!b.title || !b.title.trim()) return res.status(400).json({ error: 'Task title is required.' });

  // One or more assignees. Accepts assigneeIds (array) or a single assigneeId.
  const rawIds = Array.isArray(b.assigneeIds) ? b.assigneeIds : (b.assigneeId != null ? [b.assigneeId] : []);
  const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one person to assign.' });

  const mgr = await projectManagerId(db, pid);
  if (mgr == null) return res.status(404).json({ error: 'Project not found.' });
  const priv = req.user.accessRole === 'manager' || req.user.accessRole === 'admin';
  const canCreate = priv || mgr === req.user.id || (parent && parent.assignee_id === req.user.id);
  if (!canCreate) {
    return res.status(403).json({ error: 'Only the project manager, an admin, or the task owner can add this.' });
  }
  // Verify assignees exist, then add each to the project (auto-join).
  const { rows: emps } = await db.query('SELECT id, name FROM employees WHERE id = ANY($1)', [ids]);
  if (emps.length !== ids.length) return res.status(400).json({ error: 'One of the selected people does not exist.' });
  for (const emp of emps) {
    const joined = await ensureMember(db, pid, emp.id);
    if (joined) await logActivity(db, pid, req.user.id, 'member_added', `added ${emp.name} to the project`);
  }

  const aid = ids[0];   // first pick is the primary owner (display)
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'none';
  const completion = Math.max(0, Math.min(100, parseInt(b.completion, 10) || 0));
  const { rows } = await db.query(
    `INSERT INTO tasks (project_id, parent_task_id, assignee_id, assigned_by, task_date, start_date,
                        duration, title, details, priority, completion, tags, stipend)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [pid, parentId, aid, req.user.id, b.date || null, b.startDate || null,
     (b.duration || '').trim().slice(0, 40) || null, b.title.trim().slice(0, 300),
     (b.details || '').trim().slice(0, 4000), priority, completion,
     (b.tags || '').trim().slice(0, 300) || null, canSeeStipend(req.user) ? !!b.stipend : false]
  );
  const taskId = rows[0].id;
  for (const id of ids) {
    await db.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [taskId, id]);
  }
  const { rows: full } = await db.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
  const names = emps.map((e) => e.name).join(', ');
  const label = parent ? `subtask "${full[0].title}" under "${parent.title}"` : `"${full[0].title}"`;
  await logActivity(db, pid, req.user.id, parent ? 'subtask_added' : 'task_assigned',
    `${parent ? 'added' : 'assigned'} ${label} to ${names}`);
  // Notify assignees (except the person doing the assigning) via web push.
  sendPushToEmployees(ids.filter((id) => id !== req.user.id), {
    title: parent ? 'New subtask assigned' : 'New task assigned',
    body: `${full[0].title} · ${full[0].project_name}${full[0].task_date ? ' · due ' + full[0].task_date : ''}`,
    url: '/',
  }).catch(() => {});
  res.status(201).json({ task: scrubStipend(full[0], req.user) });
}));

// POST /api/tasks/:id/submit — post a work-update comment (any project member).
// Mirrored into the author's daily work entry so scores keep reflecting activity.
router.post('/:id/submit', requireAuth, wrap(async (req, res) => {
  const { body, attachmentNote } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Describe the work you did.' });
  const { rows } = await db.query(
    `SELECT t.id, t.title, t.assignee_id, t.project_id, p.manager_id
       FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Task not found.' });
  const task = rows[0];
  // A work update is the author's own record of what they did, so only the
  // task's assignees (and admin/HR) may post one.
  if (!(await canSeeWorkUpdates(task.id, req.user))) {
    return res.status(403).json({ error: 'Only the people this task is assigned to can post a work update.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sub } = await client.query(
      `INSERT INTO task_submissions (task_id, employee_id, body, attachment_note)
       VALUES ($1,$2,$3,$4) RETURNING id, body, attachment_note, created_at`,
      [task.id, req.user.id, body.trim().slice(0, 4000), (attachmentNote || '').trim().slice(0, 255) || null]
    );
    const bullet = JSON.stringify([`[${task.title}] ${body.trim().slice(0, 500)}`]);
    await client.query(
      `INSERT INTO work_entries (employee_id, entry_date, bullets, attachment_note)
       VALUES ($1, CURRENT_DATE, $2::jsonb, $3)
       ON CONFLICT (employee_id, entry_date)
       DO UPDATE SET bullets = work_entries.bullets || $2::jsonb,
                     attachment_note = COALESCE(EXCLUDED.attachment_note, work_entries.attachment_note),
                     updated_at = now()`,
      [req.user.id, bullet, (attachmentNote || '').trim().slice(0, 255) || null]
    );
    await logActivity(client, task.project_id, req.user.id, 'task_submission', `commented on "${task.title}"`);
    await client.query('COMMIT');
    res.status(201).json({ submission: sub[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// GET /api/tasks/:id/submissions — the comment thread on a task.
router.get('/:id/submissions', requireAuth, wrap(async (req, res) => {
  const { rows: t } = await db.query('SELECT project_id, assignee_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!t[0]) return res.status(404).json({ error: 'Task not found.' });
  if (!(await canSeeWorkUpdates(req.params.id, req.user))) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const { rows } = await db.query(
    `SELECT s.id, s.body, s.attachment_note, s.created_at, e.name AS author
     FROM task_submissions s LEFT JOIN employees e ON e.id = s.employee_id
     WHERE s.task_id = $1 ORDER BY s.created_at DESC`,
    [req.params.id]
  );
  res.json({ submissions: rows });
}));

// ── Comments (discussion only — NOT mirrored into the personal report) ──────
router.get('/:id/comments', requireAuth, wrap(async (req, res) => {
  const { rows: t } = await db.query('SELECT project_id, assignee_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!t[0]) return res.status(404).json({ error: 'Task not found.' });
  const priv = req.user.accessRole === 'manager' || req.user.accessRole === 'admin';
  if (!priv && t[0].assignee_id !== req.user.id && !(await isMember(db, t[0].project_id, req.user.id))) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const { rows } = await db.query(
    `SELECT c.id, c.body, c.created_at, c.mentions, e.name AS author
     FROM task_comments c LEFT JOIN employees e ON e.id = c.employee_id
     WHERE c.task_id = $1 ORDER BY c.created_at DESC`,
    [req.params.id]
  );
  res.json({ comments: rows });
}));

router.post('/:id/comments', requireAuth, wrap(async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Write a comment.' });
  const { rows: t } = await db.query('SELECT project_id, assignee_id, title FROM tasks WHERE id = $1', [req.params.id]);
  if (!t[0]) return res.status(404).json({ error: 'Task not found.' });
  const priv = req.user.accessRole === 'manager' || req.user.accessRole === 'admin';
  if (!priv && t[0].assignee_id !== req.user.id && !(await isMember(db, t[0].project_id, req.user.id))) {
    return res.status(403).json({ error: 'Only members of this project can comment.' });
  }

  // Tagged people: keep only ids who are actually members of this project, so a
  // comment can't tag someone unrelated. Cap to a sane number.
  let mentions = Array.isArray(req.body?.mentions) ? req.body.mentions.map(Number).filter(Number.isInteger) : [];
  mentions = [...new Set(mentions)].slice(0, 30);
  if (mentions.length) {
    const { rows: valid } = await db.query(
      'SELECT employee_id FROM project_members WHERE project_id = $1 AND employee_id = ANY($2)',
      [t[0].project_id, mentions]
    );
    mentions = valid.map((r) => r.employee_id);
  }

  const { rows } = await db.query(
    `INSERT INTO task_comments (task_id, employee_id, body, mentions) VALUES ($1,$2,$3,$4)
     RETURNING id, body, mentions, created_at`,
    [req.params.id, req.user.id, body.trim().slice(0, 4000), mentions]
  );

  // Notify tagged people (except the author), best-effort.
  const notify = mentions.filter((id) => id !== req.user.id);
  if (notify.length) {
    try {
      await sendPushToEmployees(notify, {
        title: 'You were tagged in a comment',
        body: `${req.user.name} tagged you on "${t[0].title}".`,
      });
    } catch (e) { /* best-effort */ }
  }

  res.status(201).json({ comment: rows[0] });
}));

// ── Docs ──────────────────────────────────────────────────────────────────
router.get('/:id/docs', requireAuth, wrap(async (req, res) => {
  const { rows: t } = await db.query('SELECT project_id, assignee_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!t[0]) return res.status(404).json({ error: 'Task not found.' });
  const priv = req.user.accessRole === 'manager' || req.user.accessRole === 'admin';
  if (!priv && t[0].assignee_id !== req.user.id && !(await isMember(db, t[0].project_id, req.user.id))) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.url, d.created_at, e.name AS added_by
     FROM task_docs d LEFT JOIN employees e ON e.id = d.added_by
     WHERE d.task_id = $1 ORDER BY d.created_at DESC`,
    [req.params.id]
  );
  res.json({ docs: rows });
}));

router.post('/:id/docs', requireAuth, wrap(async (req, res) => {
  const { name, url } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'A document name is required.' });
  const { rows: t } = await db.query('SELECT project_id, assignee_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!t[0]) return res.status(404).json({ error: 'Task not found.' });
  const priv = req.user.accessRole === 'manager' || req.user.accessRole === 'admin';
  if (!priv && t[0].assignee_id !== req.user.id && !(await isMember(db, t[0].project_id, req.user.id))) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const { rows } = await db.query(
    `INSERT INTO task_docs (task_id, name, url, added_by) VALUES ($1,$2,$3,$4)
     RETURNING id, name, url, created_at`,
    [req.params.id, name.trim().slice(0, 255), (url || '').trim().slice(0, 2000) || null, req.user.id]
  );
  res.status(201).json({ doc: rows[0] });
}));

router.delete('/docs/:docId', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT d.id, d.added_by, t.assignee_id, t.project_id, p.manager_id
       FROM task_docs d JOIN tasks t ON t.id = d.task_id JOIN projects p ON p.id = t.project_id
      WHERE d.id = $1`, [req.params.docId]);
  if (!rows[0]) return res.status(404).json({ error: 'Document not found.' });
  const d = rows[0];
  const allowed = req.user.accessRole === 'admin' || d.added_by === req.user.id
    || d.manager_id === req.user.id || d.assignee_id === req.user.id;
  if (!allowed) return res.status(403).json({ error: 'Not allowed.' });
  await db.query('DELETE FROM task_docs WHERE id = $1', [req.params.docId]);
  res.json({ ok: true });
}));

// ── Issues ────────────────────────────────────────────────────────────────
router.get('/:id/issues', requireAuth, wrap(async (req, res) => {
  const { rows: t } = await db.query('SELECT project_id, assignee_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!t[0]) return res.status(404).json({ error: 'Task not found.' });
  const priv = req.user.accessRole === 'manager' || req.user.accessRole === 'admin';
  if (!priv && t[0].assignee_id !== req.user.id && !(await isMember(db, t[0].project_id, req.user.id))) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const { rows } = await db.query(
    `SELECT i.id, i.title, i.status, i.created_at, e.name AS created_by
     FROM task_issues i LEFT JOIN employees e ON e.id = i.created_by
     WHERE i.task_id = $1 ORDER BY (i.status = 'closed'), i.created_at DESC`,
    [req.params.id]
  );
  res.json({ issues: rows });
}));

router.post('/:id/issues', requireAuth, wrap(async (req, res) => {
  const { title } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'An issue title is required.' });
  const { rows: t } = await db.query('SELECT project_id, assignee_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!t[0]) return res.status(404).json({ error: 'Task not found.' });
  const priv = req.user.accessRole === 'manager' || req.user.accessRole === 'admin';
  if (!priv && t[0].assignee_id !== req.user.id && !(await isMember(db, t[0].project_id, req.user.id))) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const { rows } = await db.query(
    `INSERT INTO task_issues (task_id, title, created_by) VALUES ($1,$2,$3)
     RETURNING id, title, status, created_at`,
    [req.params.id, title.trim().slice(0, 300), req.user.id]
  );
  res.status(201).json({ issue: rows[0] });
}));

router.patch('/issues/:issueId', requireAuth, wrap(async (req, res) => {
  const { status } = req.body || {};
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Status must be open or closed.' });
  const { rows } = await db.query(
    `SELECT i.id, t.assignee_id, t.project_id, p.manager_id
       FROM task_issues i JOIN tasks t ON t.id = i.task_id JOIN projects p ON p.id = t.project_id
      WHERE i.id = $1`, [req.params.issueId]);
  if (!rows[0]) return res.status(404).json({ error: 'Issue not found.' });
  const i = rows[0];
  const allowed = req.user.accessRole === 'admin' || i.manager_id === req.user.id
    || i.assignee_id === req.user.id || (await isMember(db, i.project_id, req.user.id));
  if (!allowed) return res.status(403).json({ error: 'Not allowed.' });
  await db.query('UPDATE task_issues SET status = $1 WHERE id = $2', [status, req.params.issueId]);
  res.json({ ok: true, status });
}));

// PATCH /api/tasks/:id — update status and/or any of the task fields.
// Allowed for the assignee, the project manager, or an admin.
router.patch('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Task not found.' });
  const task = rows[0];
  if (!(await canEditTask(task, req.user))) {
    return res.status(403).json({ error: 'Not allowed to update this task.' });
  }
  const b = req.body || {};
  const sets = [];
  const params = [];
  const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (b.status !== undefined) {
    if (!['pending', 'done'].includes(b.status)) return res.status(400).json({ error: 'Status must be pending or done.' });
    put('status', b.status);
    // Completing a task fills the bar; reopening one drops it back if it was full.
    if (b.status === 'done' && b.completion === undefined) put('completion', 100);
    if (b.status === 'pending' && b.completion === undefined && task.completion === 100) put('completion', 0);
  }
  if (b.completion !== undefined) {
    const c = Math.max(0, Math.min(100, parseInt(b.completion, 10) || 0));
    put('completion', c);
    if (b.status === undefined) put('status', c >= 100 ? 'done' : 'pending');
  }
  if (b.priority !== undefined) put('priority', PRIORITIES.includes(b.priority) ? b.priority : 'none');
  if (b.title !== undefined && b.title.trim()) put('title', b.title.trim().slice(0, 300));
  if (b.details !== undefined) put('details', (b.details || '').trim().slice(0, 4000));
  if (b.tags !== undefined) put('tags', (b.tags || '').trim().slice(0, 300) || null);
  if (b.stipend !== undefined && canSeeStipend(req.user)) put('stipend', !!b.stipend);
  if (b.duration !== undefined) put('duration', (b.duration || '').trim().slice(0, 40) || null);
  if (b.date !== undefined) put('task_date', b.date || null);
  if (b.startDate !== undefined) put('start_date', b.startDate || null);
  if (b.assigneeId !== undefined) {
    const aid = Number(b.assigneeId);
    if (Number.isInteger(aid)) {
      const { rows: ex } = await db.query('SELECT 1 FROM employees WHERE id = $1', [aid]);
      if (!ex[0]) return res.status(400).json({ error: 'That employee does not exist.' });
      await ensureMember(db, task.project_id, aid);   // reassigning also adds them to the project
      await db.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [task.id, aid]);
      put('assignee_id', aid);
    }
  }
  // Replace the whole assignee set (collective task edit).
  if (Array.isArray(b.assigneeIds)) {
    const ids = [...new Set(b.assigneeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length) {
      const { rows: emps } = await db.query('SELECT id FROM employees WHERE id = ANY($1)', [ids]);
      if (emps.length !== ids.length) return res.status(400).json({ error: 'One of the selected people does not exist.' });
      for (const id of ids) await ensureMember(db, task.project_id, id);
      await db.query('DELETE FROM task_assignees WHERE task_id = $1', [task.id]);
      for (const id of ids) await db.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1,$2)', [task.id, id]);
      if (!ids.includes(task.assignee_id)) put('assignee_id', ids[0]);   // keep primary valid
    }
  }
  // Stamp (or clear) the completion time whenever the effective status flips,
  // so "My Tasks" keeps a done task for the rest of that day and drops it the
  // next day.
  let newStatus;
  if (b.status !== undefined) newStatus = b.status;
  else if (b.completion !== undefined) newStatus = (Math.max(0, Math.min(100, parseInt(b.completion, 10) || 0)) >= 100 ? 'done' : 'pending');
  if (newStatus === 'done' && task.status !== 'done') put('completed_at', new Date());
  else if (newStatus === 'pending') put('completed_at', null);

  if (!sets.length) return res.json({ ok: true });
  params.push(req.params.id);
  await db.query(`UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  const { rows: full } = await db.query(`${TASK_SELECT} WHERE t.id = $1`, [req.params.id]);
  res.json({ ok: true, task: scrubStipend(full[0], req.user) });
}));

// Clear the whole work-update log or discussion thread on a task. Project
// manager or admin only. Irreversible.
async function requireTaskManager(req, res) {
  const { rows } = await db.query(
    'SELECT t.project_id, p.manager_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1',
    [req.params.id]
  );
  if (!rows[0]) { res.status(404).json({ error: 'Task not found.' }); return false; }
  if (req.user.id !== rows[0].manager_id && req.user.accessRole !== 'admin') {
    res.status(403).json({ error: 'Only the project manager or an admin can do this.' }); return false;
  }
  return true;
}
router.delete('/:id/submissions', requireAuth, wrap(async (req, res) => {
  // Work updates are private records; only admin/HR may clear them (managers
  // cannot see work updates, so they cannot clear them either).
  if (req.user.accessRole !== 'admin' && req.user.accessRole !== 'hr') {
    return res.status(403).json({ error: 'Only an admin or HR can clear work updates.' });
  }
  const { rowCount } = await db.query('DELETE FROM task_submissions WHERE task_id = $1', [req.params.id]);
  res.json({ ok: true, deleted: rowCount });
}));
router.delete('/:id/comments', requireAuth, wrap(async (req, res) => {
  if (!(await requireTaskManager(req, res))) return;
  const { rowCount } = await db.query('DELETE FROM task_comments WHERE task_id = $1', [req.params.id]);
  res.json({ ok: true, deleted: rowCount });
}));

// DELETE /api/tasks/:id — the project manager or an admin can remove a task
// (its subtasks, comments, docs and issues cascade away).
router.delete('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query('SELECT t.project_id, p.manager_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Task not found.' });
  if (req.user.id !== rows[0].manager_id && req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'Only the project manager or an admin can delete this task.' });
  }
  await db.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
