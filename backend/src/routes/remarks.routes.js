const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendPushToEmployees } = require('../utils/push');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/remarks/mine — the remarks left FOR the current user (shown on Home).
router.get('/mine', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.id, r.body, r.created_at, r.updated_at, a.name AS author
     FROM user_remarks r LEFT JOIN employees a ON a.id = r.author_id
     WHERE r.employee_id = $1 ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  res.json({ remarks: rows });
}));

// GET /api/remarks/user/:id — the remarks on one user (admin/HR, for the Users
// profile page).
router.get('/user/:id', requireAuth, requireRole('admin', 'hr'), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.id, r.body, r.created_at, r.updated_at, a.name AS author
     FROM user_remarks r LEFT JOIN employees a ON a.id = r.author_id
     WHERE r.employee_id = $1 ORDER BY r.created_at DESC`,
    [req.params.id]
  );
  res.json({ remarks: rows });
}));

// POST /api/remarks/user/:id { body } — admin/HR leave a remark for a user.
router.post('/user/:id', requireAuth, requireRole('admin', 'hr'), wrap(async (req, res) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write a remark.' });
  const { rows: emp } = await db.query('SELECT id, name FROM employees WHERE id = $1', [req.params.id]);
  if (!emp[0]) return res.status(404).json({ error: 'Employee not found.' });
  const { rows } = await db.query(
    `INSERT INTO user_remarks (employee_id, author_id, body) VALUES ($1,$2,$3)
     RETURNING id, body, created_at`,
    [emp[0].id, req.user.id, body.slice(0, 2000)]
  );
  try {
    await sendPushToEmployees([emp[0].id], { title: 'New remark for you', body: body.slice(0, 120) });
  } catch (e) { /* best-effort */ }
  res.status(201).json({ remark: rows[0] });
}));

// PATCH /api/remarks/:id { body } — admin, or the author, can edit a remark
// (e.g. to correct one given in haste or by miscommunication). Stamps
// updated_at so the person sees the latest corrected wording, marked as edited.
router.patch('/:id', requireAuth, wrap(async (req, res) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write a remark.' });
  const { rows: existing } = await db.query('SELECT author_id, employee_id FROM user_remarks WHERE id = $1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: 'Remark not found.' });
  if (req.user.accessRole !== 'admin' && existing[0].author_id !== req.user.id) {
    return res.status(403).json({ error: 'Only an admin or the author can edit this remark.' });
  }
  const { rows } = await db.query(
    `UPDATE user_remarks SET body = $1, updated_at = now() WHERE id = $2
     RETURNING id, body, created_at, updated_at`,
    [body.slice(0, 2000), req.params.id]
  );
  try {
    await sendPushToEmployees([existing[0].employee_id], { title: 'A remark for you was updated', body: body.slice(0, 120) });
  } catch (e) { /* best-effort */ }
  res.json({ remark: rows[0] });
}));

// DELETE /api/remarks/:id — admin, or the author, can remove a remark.
router.delete('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query('SELECT author_id FROM user_remarks WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Remark not found.' });
  if (req.user.accessRole !== 'admin' && rows[0].author_id !== req.user.id) {
    return res.status(403).json({ error: 'Only an admin or the author can delete this remark.' });
  }
  await db.query('DELETE FROM user_remarks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
