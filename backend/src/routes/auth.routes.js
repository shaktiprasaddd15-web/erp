const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth, activeGrant } = require('../middleware/auth');

const router = express.Router();

// Slow brute-force attempts against a single account. Keyed by the login
// identifier (email/name/code) rather than IP, so an office behind one shared
// public IP (NAT) doesn't collectively trip a per-IP limit when everyone signs
// in in the morning. Per-account guessing is still bounded here, and the DB
// lockout (5 wrong tries -> 15-min lock, below) is the primary defence.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // attempts per account per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.body && req.body.email ? 'acct:' + String(req.body.email).toLowerCase().trim() : req.ip,
  message: { error: 'Too many login attempts for this account. Please try again in a few minutes.' },
});

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

async function logAudit(actorId, action, target, ip) {
  try {
    await db.query(
      'INSERT INTO audit_log (actor_employee_id, action, target, ip_address) VALUES ($1,$2,$3,$4)',
      [actorId, action, target, ip]
    );
  } catch (e) {
    console.error('audit log failed', e.message);
  }
}

// POST /api/auth/login  { email, password }
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  // Accept an email, a full name, or an employee code as the login identifier —
  // matched case-insensitively — so bootstrap accounts like "Satvikk" work too.
  const identifier = email.toLowerCase().trim();
  const { rows } = await db.query(
    'SELECT * FROM employees WHERE lower(email) = $1 OR lower(name) = $1 OR lower(employee_code) = $1 LIMIT 1',
    [identifier]
  );
  const user = rows[0];

  // Always compare against a dummy hash if user not found — avoids leaking
  // "which emails exist" via response timing.
  const hashToCheck = user ? user.password_hash : '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const passwordOk = await bcrypt.compare(password, hashToCheck);

  if (!user || !user.is_active) {
    await logAudit(null, 'login_failed', email, req.ip);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(423).json({ error: `Account temporarily locked. Try again after ${new Date(user.locked_until).toLocaleTimeString()}.` });
  }

  if (!passwordOk) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS
      ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
      : null;
    await db.query(
      'UPDATE employees SET failed_attempts = $1, locked_until = $2 WHERE id = $3',
      [lock ? 0 : attempts, lock, user.id]
    );
    await logAudit(user.id, 'login_failed', email, req.ip);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  // success — reset lockout counters
  await db.query('UPDATE employees SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
  await logAudit(user.id, 'login_success', email, req.ip);

  const token = jwt.sign(
    {
      id: user.id,
      employeeCode: user.employee_code,
      name: user.name,
      accessRole: user.access_role,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  const grant = await activeGrant(user.id);
  res.json({
    token,
    user: {
      id: user.id,
      employeeCode: user.employee_code,
      name: user.name,
      email: user.email,
      department: user.department,
      jobTitle: user.job_title,
      accessRole: grant ? grant.granted_role : user.access_role,
      baseRole: user.access_role,
      tempAccess: grant ? { role: grant.granted_role, expiresAt: grant.expires_at } : null,
      mustResetPassword: user.must_reset_pw,
      needsPersonalDetails: !user.personal_details_done || (user.access_role !== 'admin' && (!user.date_of_birth || !user.joining_date)),
      needsInternshipInfo: user.access_role !== 'admin' && !user.internship_asked,
      dob: user.date_of_birth, joiningDate: user.joining_date,
    },
  });
});

// POST /api/auth/change-password  { currentPassword, newPassword }
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 10) {
    return res.status(400).json({ error: 'New password must be at least 10 characters.' });
  }

  const { rows } = await db.query('SELECT * FROM employees WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const ok = await bcrypt.compare(currentPassword || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });

  const newHash = await bcrypt.hash(newPassword, 12);
  await db.query(
    'UPDATE employees SET password_hash = $1, must_reset_pw = false, updated_at = now() WHERE id = $2',
    [newHash, user.id]
  );
  await logAudit(user.id, 'password_changed', user.email, req.ip);

  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, employee_code, name, email, department, job_title, access_role, must_reset_pw, personal_details_done, internship_asked, date_of_birth, joining_date FROM employees WHERE id = $1',
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  // req.user.accessRole already reflects any active temporary grant.
  const user = { ...rows[0], base_role: rows[0].access_role, access_role: req.user.accessRole, temp_access: req.user.tempAccess || null };
  res.json({ user });
});

module.exports = router;
// Exposed so the admin "unblock login" action can also clear a person's
// in-memory rate-limit counter (keyed by "acct:<login identifier>"), not just
// the database lockout.
module.exports.loginLimiter = loginLimiter;
