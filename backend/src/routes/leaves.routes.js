const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendPushToEmployees } = require('../utils/push');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// POST /api/leaves — an employee files a leave (single day or a period) to the
// HR person they choose. It is also visible to the managers of the projects the
// employee is a member of.
router.post('/', requireAuth, wrap(async (req, res) => {
  const { startDate, reason, hrId } = req.body || {};
  const endDate = req.body?.endDate || startDate;   // single day → end = start
  if (!startDate) return res.status(400).json({ error: 'A leave date is required.' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Please give a reason for your leave.' });
  if (endDate < startDate) return res.status(400).json({ error: 'The end date cannot be before the start date.' });

  // Validate the chosen HR: anyone on the HR team — either the HR access role
  // or someone in the HR department (e.g. an HR intern) — who is active.
  let hr = null;
  if (hrId) {
    const { rows } = await db.query(
      "SELECT id, name FROM employees WHERE id = $1 AND is_active = true AND (access_role = 'hr' OR lower(department) = 'hr')",
      [Number(hrId)]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Please choose a valid HR to submit to.' });
    hr = rows[0];
  } else {
    return res.status(400).json({ error: 'Please choose an HR to submit your leave to.' });
  }

  const { rows } = await db.query(
    `INSERT INTO leave_requests (employee_id, start_date, end_date, reason, hr_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, start_date, end_date, reason, created_at`,
    [req.user.id, startDate, endDate, reason.trim().slice(0, 2000), hr.id]
  );

  // Notify the chosen HR and the managers of this person's projects (best-effort).
  try {
    const { rows: mgrs } = await db.query(
      `SELECT DISTINCT p.manager_id AS id FROM project_members pm
         JOIN projects p ON p.id = pm.project_id
        WHERE pm.employee_id = $1 AND p.manager_id IS NOT NULL AND p.manager_id <> $1`,
      [req.user.id]
    );
    const targets = [...new Set([hr.id, ...mgrs.map((m) => m.id)])];
    await sendPushToEmployees(targets, {
      title: 'Leave request',
      body: `${req.user.name} filed a leave (${startDate}${endDate !== startDate ? ' – ' + endDate : ''}).`,
    });
  } catch (e) { /* push is best-effort */ }

  res.status(201).json({ leave: rows[0] });
}));

// GET /api/leaves/mine — the caller's own leave requests.
router.get('/mine', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT l.id, l.start_date, l.end_date, l.reason, l.created_at, hr.name AS hr_name
     FROM leave_requests l LEFT JOIN employees hr ON hr.id = l.hr_id
     WHERE l.employee_id = $1 ORDER BY l.start_date DESC`,
    [req.user.id]
  );
  res.json({ leaves: rows });
}));

// GET /api/leaves — leave visibility by who's asking:
//   admin              → every leave (with department / employee filters)
//   anyone else        → leaves submitted TO them (they were chosen as the HR),
//                        AND, if they're a manager, their project team's leaves.
// So any HR-team member (even an HR intern without the HR access role) can see
// the leaves people sent them. Employees who were never chosen simply see none.
router.get('/', requireAuth, wrap(async (req, res) => {
  const role = req.user.accessRole;
  const clauses = [];
  const params = [];

  if (role !== 'admin') {
    const ors = [];
    params.push(req.user.id); ors.push(`l.hr_id = $${params.length}`);          // submitted to me
    if (role === 'manager') {
      params.push(req.user.id);
      ors.push(`l.employee_id IN (
        SELECT pm.employee_id FROM project_members pm
          JOIN projects p ON p.id = pm.project_id
         WHERE p.manager_id = $${params.length})`);                              // my team
    }
    clauses.push(`(${ors.join(' OR ')})`);
  }

  // Optional filters (admins get the full set and can filter it).
  if (role === 'admin' && req.query.department && req.query.department !== 'all') {
    params.push(req.query.department);
    clauses.push(`e.department = $${params.length}`);
  }
  if (role === 'admin' && req.query.employeeId) {
    params.push(Number(req.query.employeeId));
    clauses.push(`l.employee_id = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT l.id, l.start_date, l.end_date, l.reason, l.created_at,
            e.id AS employee_id, e.name AS employee_name, e.employee_code, e.department, e.job_title,
            hr.name AS hr_name
     FROM leave_requests l
       JOIN employees e ON e.id = l.employee_id
       LEFT JOIN employees hr ON hr.id = l.hr_id
     ${where} ORDER BY l.created_at DESC LIMIT 500`,
    params
  );
  res.json({ leaves: rows });
}));

module.exports = router;
