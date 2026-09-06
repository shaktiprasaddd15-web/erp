const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Shared onboarding password for new accounts and admin-triggered resets, read
// from the DEFAULT_PASSWORD environment variable so the whole team can be given
// one common credential instead of a unique password each. It is paired with
// must_reset_pw = true everywhere it's used, so each person is still forced to
// set their own password on first login. When the env var is not configured we
// fall back to a per-account random string (the original behaviour), so nothing
// breaks and no credential is ever hardcoded in source.
function onboardingPassword() {
  return process.env.DEFAULT_PASSWORD || crypto.randomBytes(9).toString('base64url');
}

// GET /api/employees — directory (id, name, dept, role) for the "select employee"
// UI element. Available to any authenticated user (needed to render dropdowns),
// but never returns password hashes or emails to non-admins.
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, employee_code, name, department, job_title, access_role, is_active
     FROM employees ORDER BY department, name`
  );
  res.json({ employees: rows });
});

// POST /api/employees — higher officials (manager/admin) create a new account.
// The account starts with the shared onboarding password (DEFAULT_PASSWORD) and
// must_reset_pw = true, so the whole team can be handed one common credential
// and each person is forced to set their own on first login. Guardrail: only an
// admin may grant a manager/admin access role — a manager can only add
// ordinary (intern/employee) accounts, so they can't mint new admins.
router.post('/', requireAuth, requireRole('manager', 'admin'), async (req, res) => {
  const { name, email, department, jobTitle, accessRole, employeeCode } = req.body || {};
  if (!name || !email || !department || !jobTitle || !employeeCode) {
    return res.status(400).json({ error: 'name, email, department, jobTitle, employeeCode are required.' });
  }
  let role = ['employee', 'manager', 'admin', 'hr'].includes(accessRole) ? accessRole : 'employee';
  if (req.user.accessRole !== 'admin') role = 'employee';

  const tempPassword = onboardingPassword(); // shared onboarding password, changed on first login
  const hash = await bcrypt.hash(tempPassword, 12);

  try {
    const { rows } = await db.query(
      `INSERT INTO employees (employee_code, name, email, password_hash, department, job_title, access_role, must_reset_pw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       RETURNING id, employee_code, name, email, department, job_title, access_role`,
      [employeeCode, name, email.toLowerCase().trim(), hash, department, jobTitle, role]
    );
    res.status(201).json({ employee: rows[0], temporaryPassword: tempPassword });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An employee with that code or email already exists.' });
    }
    throw err;
  }
});

// POST /api/employees/:id/reset-password — higher officials force-reset a
// password. Guardrail: a manager may only reset ordinary (employee) accounts;
// resetting another manager/admin requires admin.
router.post('/:id/reset-password', requireAuth, requireRole('manager', 'admin'), async (req, res) => {
  const { rows: target } = await db.query('SELECT access_role FROM employees WHERE id = $1', [req.params.id]);
  if (!target[0]) return res.status(404).json({ error: 'Employee not found.' });
  if (req.user.accessRole !== 'admin' && target[0].access_role !== 'employee') {
    return res.status(403).json({ error: 'Only an admin can reset a manager or admin account.' });
  }

  const tempPassword = onboardingPassword(); // same shared onboarding password
  const hash = await bcrypt.hash(tempPassword, 12);
  await db.query(
    'UPDATE employees SET password_hash = $1, must_reset_pw = true, failed_attempts = 0, locked_until = NULL WHERE id = $2',
    [hash, req.params.id]
  );
  res.json({ temporaryPassword: tempPassword });
});

// PATCH /api/employees/:id — admin only: edit a user's name, department and
// permanent access level.
router.patch('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const sets = [];
  const params = [];
  const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' });
    put('name', name.slice(0, 120));
  }
  if (b.department !== undefined) {
    const dept = String(b.department).trim();
    if (!dept) return res.status(400).json({ error: 'Department cannot be empty.' });
    put('department', dept.slice(0, 100));
  }
  if (b.accessRole !== undefined) {
    if (!['employee', 'manager', 'admin', 'hr'].includes(b.accessRole)) {
      return res.status(400).json({ error: 'Invalid access level.' });
    }
    // Don't let an admin lock themselves out by demoting their own account.
    if (id === req.user.id && b.accessRole !== 'admin') {
      return res.status(400).json({ error: 'You cannot change your own access level.' });
    }
    put('access_role', b.accessRole);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

  params.push(id);
  const { rows } = await db.query(
    `UPDATE employees SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}
     RETURNING id, name, department, access_role`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'Employee not found.' });
  await db.query(
    'INSERT INTO audit_log (actor_employee_id, action, target, ip_address) VALUES ($1,$2,$3,$4)',
    [req.user.id, 'employee_updated', rows[0].id + '', req.ip]
  );
  res.json({ employee: rows[0] });
});

// PATCH /api/employees/:id/status — admin only: activate/deactivate an account
// (a softer alternative to deletion when someone leaves the company).
router.patch('/:id/status', requireAuth, requireRole('admin'), async (req, res) => {
  const { isActive } = req.body || {};
  const { rowCount } = await db.query('UPDATE employees SET is_active = $1 WHERE id = $2', [!!isActive, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Employee not found.' });
  res.json({ ok: true });
});

// DELETE /api/employees/:id — admin only: permanently erase a user and all of
// their personal data (work entries, project memberships, and tasks assigned to
// them all cascade away; audit rows and task-assigner links null out). Company
// projects they MANAGE are not destroyed — ownership is reassigned to the acting
// admin first, so shared work survives. Irreversible.
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  const { rows } = await db.query('SELECT id, name FROM employees WHERE id = $1', [targetId]);
  if (!rows[0]) return res.status(404).json({ error: 'Employee not found.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Keep managed projects alive by handing them to the admin doing the delete.
    await client.query('UPDATE projects SET manager_id = $1, updated_at = now() WHERE manager_id = $2', [req.user.id, targetId]);
    // Remove the person; FKs cascade their entries, memberships and tasks.
    await client.query('DELETE FROM employees WHERE id = $1', [targetId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, name: rows[0].name });
});

module.exports = router;
