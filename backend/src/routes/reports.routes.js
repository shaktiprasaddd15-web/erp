const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeStats, scoreLabel, dailyScore } = require('../utils/scoring');

const router = express.Router();

// A manager's "team": everyone who is a member of a project they manage.
// Managers may view these people's profiles and work updates (read-only) but
// nobody else's. Admin/HR see everyone.
async function managerTeamIds(managerId) {
  const { rows } = await db.query(
    `SELECT DISTINCT pm.employee_id AS id FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
      WHERE p.manager_id = $1`,
    [managerId]
  );
  return rows.map((r) => r.id);
}
async function isTeamMember(managerId, employeeId) {
  const { rows } = await db.query(
    `SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE p.manager_id = $1 AND pm.employee_id = $2 LIMIT 1`,
    [managerId, Number(employeeId)]
  );
  return rows.length > 0;
}
// For a manager, ensure the target employee is on their team (else 403). Admin
// and HR pass through. Returns true if the request may proceed.
async function ensureCanViewEmployee(req, res, employeeId) {
  if (req.user.accessRole === 'manager') {
    if (!(await isTeamMember(req.user.id, employeeId))) {
      res.status(403).json({ error: 'You can only view your own team members.' });
      return false;
    }
  }
  return true;
}

// GET /api/reports/employees?department=Marketing
// Admin/HR see everyone; a manager sees only their team.
router.get('/employees', requireAuth, requireRole('admin', 'hr', 'manager'), async (req, res) => {
  const { department, from, to } = req.query;
  const useRange = !!(from && to);
  const params = [];
  const conds = [];
  if (department && department !== 'all') {
    params.push(department);
    conds.push(`e.department = $${params.length}`);
  }
  // Managers only ever see their own team.
  if (req.user.accessRole === 'manager') {
    const team = await managerTeamIds(req.user.id);
    if (!team.length) return res.json({ employees: [] });
    params.push(team);
    conds.push(`e.id = ANY($${params.length})`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  // Email and access role are included so the admin-only Users directory can
  // show full contact info alongside each person's work history.
  const { rows: employees } = await db.query(
    `SELECT e.id, e.employee_code, e.name, e.department, e.job_title, e.email, e.access_role, e.is_active
     FROM employees e ${where} ORDER BY e.name`,
    params
  );

  const { rows: entries } = useRange
    ? await db.query(
        `SELECT employee_id, entry_date, bullets, attachment_note, attachment_url FROM work_entries
         WHERE entry_date BETWEEN $1 AND $2`,
        [from, to]
      )
    : await db.query(
        `SELECT employee_id, entry_date, bullets, attachment_note, attachment_url FROM work_entries
         WHERE entry_date >= (CURRENT_DATE - INTERVAL '30 days')`
      );

  const byEmployee = {};
  entries.forEach((e) => {
    (byEmployee[e.employee_id] ||= []).push(e);
  });

  const range = useRange ? { from, to } : null;

  // Per-employee task counts (assigned vs. completed), covering both the primary
  // assignee and collective assignees, deduped per (task, person). Admin-only —
  // the Tasks view in Performance is restricted to admins.
  const empIds = employees.map((e) => e.id);
  const taskMap = {};
  if (req.user.accessRole === 'admin' && empIds.length) {
    const { rows: tc } = await db.query(
      `WITH assignments AS (
         SELECT DISTINCT t.id AS task_id, t.status, u.emp_id
         FROM tasks t
         JOIN LATERAL (
           SELECT t.assignee_id AS emp_id WHERE t.assignee_id = ANY($1)
           UNION
           SELECT ta.employee_id FROM task_assignees ta WHERE ta.task_id = t.id AND ta.employee_id = ANY($1)
         ) u ON true
       )
       SELECT emp_id, COUNT(*)::int AS assigned,
              COUNT(*) FILTER (WHERE status = 'done')::int AS done
       FROM assignments GROUP BY emp_id`,
      [empIds]
    );
    tc.forEach((r) => { taskMap[r.emp_id] = { assigned: r.assigned, done: r.done }; });
  }

  const result = employees.map((emp) => {
    const stats = computeStats(byEmployee[emp.id] || [], 30, range);
    const t = taskMap[emp.id] || { assigned: 0, done: 0 };
    return { ...emp, score: stats.score, label: scoreLabel(stats.score), tasks_assigned: t.assigned, tasks_done: t.done };
  });

  res.json({ employees: result });
});

// GET /api/reports/employees/:id?from=&to= — manager/admin only. Full history + stats.
router.get('/employees/:id', requireAuth, requireRole('admin', 'hr', 'manager'), async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;
  if (!(await ensureCanViewEmployee(req, res, id))) return;

  const { rows: empRows } = await db.query(
    'SELECT id, employee_code, name, department, job_title, email, access_role, locked_until, failed_attempts, date_of_birth, joining_date, internship_tenure, internship_start_date, internship_end_date FROM employees WHERE id = $1',
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
router.get('/employees/:id/projects', requireAuth, requireRole('admin', 'hr', 'manager'), async (req, res) => {
  const { id } = req.params;
  if (!(await ensureCanViewEmployee(req, res, id))) return;
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
router.get('/employees/:id/projects/:pid/tasks', requireAuth, requireRole('admin', 'hr', 'manager'), async (req, res) => {
  const { id, pid } = req.params;
  if (!(await ensureCanViewEmployee(req, res, id))) return;
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
router.get('/employees/:id/calendar', requireAuth, requireRole('admin', 'hr', 'manager'), async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;
  if (!(await ensureCanViewEmployee(req, res, id))) return;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates are required.' });

  // Work-report days (work_entries with a date in range).
  const { rows: reps } = await db.query(
    `SELECT DISTINCT entry_date FROM work_entries
     WHERE employee_id = $1 AND entry_date BETWEEN $2 AND $3`,
    [id, from, to]
  );
  const reportDays = reps.map((r) => r.entry_date);

  // Expand each overlapping APPROVED leave range into individual days within
  // [from,to]. Pending/rejected leaves are not counted.
  const { rows: leaves } = await db.query(
    `SELECT generate_series(GREATEST(start_date, $2::date), LEAST(end_date, $3::date), interval '1 day')::date AS d
     FROM leave_requests
     WHERE employee_id = $1 AND status = 'approved' AND start_date <= $3::date AND end_date >= $2::date`,
    [id, from, to]
  );
  const leaveDays = [...new Set(leaves.map((r) => r.d))];

  res.json({ reportDays, leaveDays });
});

// GET /api/reports/employees/:id/daily?from=&to= — a daily rating (0-100) for
// each day in the range, based on that day's work update. (manager/admin/hr)
router.get('/employees/:id/daily', requireAuth, requireRole('admin', 'hr', 'manager'), async (req, res) => {
  const { id, } = req.params;
  const { from, to } = req.query;
  if (!(await ensureCanViewEmployee(req, res, id))) return;
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

// GET /api/reports/hr-overview — HR/admin only. One row per active employee for
// the HR board: birthday, internship window (joining → last date) and how many
// leave days they've taken this calendar month. Used to spot upcoming birthdays
// and internships that are about to end.
router.get('/hr-overview', requireAuth, requireRole('admin', 'hr'), async (req, res) => {
  const { rows: employees } = await db.query(
    `SELECT id, employee_code, name, department, job_title,
            date_of_birth, joining_date, internship_start_date, internship_end_date, internship_tenure
     FROM employees WHERE is_active = true ORDER BY name`
  );

  // Approved leave days that fall in the current calendar month, per employee.
  const { rows: leaveRows } = await db.query(
    `SELECT employee_id,
            COUNT(*)::int AS days
     FROM (
       SELECT lr.employee_id,
              generate_series(
                GREATEST(lr.start_date, date_trunc('month', CURRENT_DATE)::date),
                LEAST(lr.end_date, (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date),
                interval '1 day'
              ) AS d
       FROM leave_requests lr
       WHERE lr.status = 'approved'
         AND lr.start_date <= (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date
         AND lr.end_date   >= date_trunc('month', CURRENT_DATE)::date
     ) x
     GROUP BY employee_id`
  );
  const leaveByEmp = {};
  leaveRows.forEach((r) => { leaveByEmp[r.employee_id] = r.days; });

  const result = employees.map((e) => ({ ...e, leaves_this_month: leaveByEmp[e.id] || 0 }));
  res.json({ employees: result });
});

module.exports = router;
