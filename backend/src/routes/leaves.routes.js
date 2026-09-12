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

  // Filed leaves start as 'pending' (see migration default) and must be approved
  // by the chosen HR or an admin before they count.
  const { rows } = await db.query(
    `INSERT INTO leave_requests (employee_id, start_date, end_date, reason, hr_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, start_date, end_date, reason, status, created_at`,
    [req.user.id, startDate, endDate, reason.trim().slice(0, 2000), hr.id]
  );

  // Send it to the chosen HR and all admins for approval (best-effort push).
  try {
    const { rows: admins } = await db.query(
      "SELECT id FROM employees WHERE access_role = 'admin' AND is_active = true"
    );
    const targets = [...new Set([hr.id, ...admins.map((a) => a.id)])].filter((id) => id !== req.user.id);
    await sendPushToEmployees(targets, {
      title: 'Leave approval needed',
      body: `${req.user.name} requested leave (${startDate}${endDate !== startDate ? ' – ' + endDate : ''}). Review it in Leave.`,
    });
  } catch (e) { /* push is best-effort */ }

  res.status(201).json({ leave: rows[0] });
}));

// GET /api/leaves/mine — the caller's own leave requests.
router.get('/mine', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT l.id, l.start_date, l.end_date, l.reason, l.status, l.hr_remark, l.created_at,
            hr.name AS hr_name, d.name AS decided_by_name
     FROM leave_requests l
       LEFT JOIN employees hr ON hr.id = l.hr_id
       LEFT JOIN employees d ON d.id = l.decided_by
     WHERE l.employee_id = $1 ORDER BY l.start_date DESC`,
    [req.user.id]
  );
  res.json({ leaves: rows });
}));

// PATCH /api/leaves/:id/decision { decision: 'approved' | 'rejected' } — the
// chosen HR or an admin approves/rejects a pending leave. Only an approved leave
// is counted (e.g. shown as a leave day on the calendar).
router.patch('/:id/decision', requireAuth, wrap(async (req, res) => {
  const decision = req.body?.decision;
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "rejected".' });
  }
  const { rows: lr } = await db.query('SELECT id, employee_id, hr_id FROM leave_requests WHERE id = $1', [req.params.id]);
  if (!lr[0]) return res.status(404).json({ error: 'Leave request not found.' });
  const canDecide = req.user.accessRole === 'admin' || lr[0].hr_id === req.user.id;
  if (!canDecide) return res.status(403).json({ error: 'Only the assigned HR or an admin can decide this leave.' });

  const { rows } = await db.query(
    `UPDATE leave_requests SET status = $1, decided_by = $2, decided_at = now() WHERE id = $3
     RETURNING id, status`,
    [decision, req.user.id, req.params.id]
  );
  // Tell the employee the outcome (best-effort).
  try {
    await sendPushToEmployees([lr[0].employee_id], {
      title: `Leave ${decision}`,
      body: `Your leave request was ${decision} by ${req.user.name}.`,
    });
  } catch (e) { /* best-effort */ }
  res.json({ leave: rows[0] });
}));

// PATCH /api/leaves/:id/remark { remark } — the chosen HR or an admin adds/edits
// a remark on a leave. Visible to the employee, all admins, and the managers of
// that employee's projects.
router.patch('/:id/remark', requireAuth, wrap(async (req, res) => {
  const remark = (req.body?.remark || '').trim();
  const { rows: lr } = await db.query('SELECT id, employee_id, hr_id FROM leave_requests WHERE id = $1', [req.params.id]);
  if (!lr[0]) return res.status(404).json({ error: 'Leave request not found.' });
  const canRemark = req.user.accessRole === 'admin' || lr[0].hr_id === req.user.id;
  if (!canRemark) return res.status(403).json({ error: 'Only the assigned HR or an admin can add a remark.' });
  const { rows } = await db.query(
    'UPDATE leave_requests SET hr_remark = $1 WHERE id = $2 RETURNING id, hr_remark',
    [remark ? remark.slice(0, 2000) : null, req.params.id]
  );
  try {
    if (remark) await sendPushToEmployees([lr[0].employee_id], { title: 'Remark on your leave', body: remark.slice(0, 120) });
  } catch (e) { /* best-effort */ }
  res.json({ leave: rows[0] });
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
    `SELECT l.id, l.start_date, l.end_date, l.reason, l.status, l.created_at, l.hr_id, l.decided_at, l.hr_remark,
            e.id AS employee_id, e.name AS employee_name, e.employee_code, e.department, e.job_title,
            hr.name AS hr_name, d.name AS decided_by_name
     FROM leave_requests l
       JOIN employees e ON e.id = l.employee_id
       LEFT JOIN employees hr ON hr.id = l.hr_id
       LEFT JOIN employees d ON d.id = l.decided_by
     ${where} ORDER BY l.created_at DESC LIMIT 500`,
    params
  );
  res.json({ leaves: rows });
}));

module.exports = router;
