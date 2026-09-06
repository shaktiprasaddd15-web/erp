const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeStats, scoreLabel, dailyScore } = require('../utils/scoring');

const router = express.Router();

// GET /api/reports/employees?department=Marketing — manager/admin only.
// Returns every employee with their current engagement score for the sidebar list.
router.get('/employees', requireAuth, requireRole('manager', 'admin', 'hr'), async (req, res) => {
  const { department } = req.query;
  const params = [];
  let where = '';
  if (department && department !== 'all') {
    params.push(department);
    where = 'WHERE e.department = $1';
  }

  // Email and access role are included so the admin-only Users directory can
  // show full contact info alongside each person's work history.
  const { rows: employees } = await db.query(
    `SELECT e.id, e.employee_code, e.name, e.department, e.job_title, e.email, e.access_role, e.is_active
     FROM employees e ${where} ORDER BY e.name`,
    params
  );

  const { rows: entries } = await db.query(
    `SELECT employee_id, entry_date, bullets, attachment_note, attachment_url FROM work_entries
     WHERE entry_date >= (CURRENT_DATE - INTERVAL '30 days')`
  );

  const byEmployee = {};
  entries.forEach((e) => {
    (byEmployee[e.employee_id] ||= []).push(e);
  });

  const result = employees.map((emp) => {
    const stats = computeStats(byEmployee[emp.id] || []);
    return { ...emp, score: stats.score, label: scoreLabel(stats.score) };
  });

  res.json({ employees: result });
});

// GET /api/reports/employees/:id?from=&to= — manager/admin only. Full history + stats.
router.get('/employees/:id', requireAuth, requireRole('manager', 'admin', 'hr'), async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;

  const { rows: empRows } = await db.query(
    'SELECT id, employee_code, name, department, job_title, email, access_role, locked_until, failed_attempts FROM employees WHERE id = $1',
    [id]
  );
  const employee = empRows[0];
  if (!employee) return res.status(404).json({ error: 'Employee not found.' });

  // stats always computed on the trailing 30 days regardless of the display filter
  const { rows: statsEntries } = await db.query(
    `SELECT entry_date, bullets, attachment_note, attachment_url FROM work_entries
     WHERE employee_id = $1 AND entry_date >= (CURRENT_DATE - INTERVAL '30 days')`,
    [id]
  );
  const stats = computeStats(statsEntries);

  const clauses = ['employee_id = $1'];
  const params = [id];
  if (from) { params.push(from); clauses.push(`entry_date >= $${params.length}`); }
  if (to) { params.push(to); clauses.push(`entry_date <= $${params.length}`); }

  const { rows: history } = await db.query(
    `SELECT entry_date, bullets, attachment_note, attachment_url FROM work_entries
     WHERE ${clauses.join(' AND ')} ORDER BY entry_date DESC`,
    params
  );

  await db.query(
    'INSERT INTO audit_log (actor_employee_id, action, target, ip_address) VALUES ($1,$2,$3,$4)',
    [req.user.id, 'report_view', employee.employee_code, req.ip]
  );

  res.json({ employee, stats: { ...stats, label: scoreLabel(stats.score) }, history });
});

// DELETE /api/reports/employees/:id/history — admin only: permanently clear an
// employee's entire work-update history (their entries in the personal report).
// This also resets their engagement score, since it's computed from these
// entries. Irreversible.
router.delete('/employees/:id/history', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { rows: emp } = await db.query('SELECT employee_code FROM employees WHERE id = $1', [req.params.id]);
    if (!emp[0]) return res.status(404).json({ error: 'Employee not found.' });
    const { rowCount } = await db.query('DELETE FROM work_entries WHERE employee_id = $1', [req.params.id]);
    await db.query(
      'INSERT INTO audit_log (actor_employee_id, action, target, ip_address) VALUES ($1,$2,$3,$4)',
      [req.user.id, 'history_cleared', emp[0].employee_code, req.ip]
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reports/employees/:id/projects — the projects this employee is a
// member of, with how many of their tasks are done. (manager/admin)
router.get('/employees/:id/projects', requireAuth, requireRole('manager', 'admin', 'hr'), async (req, res) => {
  const { id } = req.params;
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.status, p.department, p.priority,
            (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id
               AND (t.assignee_id = $1 OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.employee_id = $1))) AS my_tasks,
            (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'done'
               AND (t.assignee_id = $1 OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.employee_id = $1))) AS my_done
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id AND pm.employee_id = $1
     ORDER BY p.updated_at DESC`,
    [id]
  );
  res.json({ projects: rows });
});

// GET /api/reports/employees/:id/projects/:pid/tasks — this employee's tasks in
// one project, each with its completion state and its work-update comments.
router.get('/employees/:id/projects/:pid/tasks', requireAuth, requireRole('manager', 'admin', 'hr'), async (req, res) => {
  const { id, pid } = req.params;
  const { rows: tasks } = await db.query(
    `SELECT t.id, t.title, t.status, t.completion, t.priority, t.task_date
     FROM tasks t WHERE t.project_id = $1
       AND (t.assignee_id = $2 OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.employee_id = $2))
     ORDER BY (t.status = 'done'), t.created_at`,
    [pid, id]
  );
  const ids = tasks.map((t) => t.id);
  const byTask = {};
  if (ids.length) {
    const { rows: subs } = await db.query(
      `SELECT s.task_id, s.body, s.attachment_note, s.created_at, e.name AS author
       FROM task_submissions s LEFT JOIN employees e ON e.id = s.employee_id
       WHERE s.task_id = ANY($1) ORDER BY s.created_at DESC`,
      [ids]
    );
    subs.forEach((s) => { (byTask[s.task_id] ||= []).push(s); });
  }
  tasks.forEach((t) => { t.updates = byTask[t.id] || []; });
  res.json({ tasks });
});

// GET /api/reports/employees/:id/calendar?from=&to= — for the report calendar:
// the days this employee was on leave and the days they filed a work report,
// within the given range. (manager/admin/hr)
router.get('/employees/:id/calendar', requireAuth, requireRole('manager', 'admin', 'hr'), async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates are required.' });

  // Work-report days (work_entries with a date in range).
  const { rows: reps } = await db.query(
    `SELECT DISTINCT entry_date FROM work_entries
     WHERE employee_id = $1 AND entry_date BETWEEN $2 AND $3`,
    [id, from, to]
  );
  const reportDays = reps.map((r) => r.entry_date);

  // Expand each overlapping leave range into individual days within [from,to].
  const { rows: leaves } = await db.query(
    `SELECT generate_series(GREATEST(start_date, $2::date), LEAST(end_date, $3::date), interval '1 day')::date AS d
     FROM leave_requests
     WHERE employee_id = $1 AND start_date <= $3::date AND end_date >= $2::date`,
    [id, from, to]
  );
  const leaveDays = [...new Set(leaves.map((r) => r.d))];

  res.json({ reportDays, leaveDays });
});

// GET /api/reports/employees/:id/daily?from=&to= — a daily rating (0-100) for
// each day in the range, based on that day's work update. (manager/admin/hr)
router.get('/employees/:id/daily', requireAuth, requireRole('manager', 'admin', 'hr'), async (req, res) => {
  const { id, } = req.params;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates are required.' });

  const { rows } = await db.query(
    `SELECT entry_date, bullets, attachment_note, attachment_url FROM work_entries
     WHERE employee_id = $1 AND entry_date BETWEEN $2 AND $3`,
    [id, from, to]
  );
  const byDate = {};
  rows.forEach((r) => { byDate[r.entry_date] = r; });

  // Emit one point per calendar day in [from, to] (0 where nothing was logged).
  const days = [];
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    days.push({ date: iso, score: dailyScore(byDate[iso] || null) });
  }
  res.json({ days });
});

module.exports = router;
