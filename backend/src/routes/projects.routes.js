const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Express 4 doesn't forward rejected promises from async handlers to the error
// middleware, so wrap each handler to turn a throw into a clean 500 response.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const VALID_STATUS = ['open', 'paused', 'closed'];
const VALID_PRIORITY = ['none', 'low', 'medium', 'high'];

async function logActivity(q, projectId, actorId, action, detail) {
  try {
    await q.query(
      'INSERT INTO project_activity (project_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
      [projectId, actorId, action, detail]
    );
  } catch (e) { console.error('activity log failed', e.message); }
}

// Shared SELECT that decorates a project with its manager's name, member count,
// and the assigned member list as JSON.
const PROJECT_SELECT = `
  SELECT p.id, p.name, p.description, p.department, p.status, p.priority,
         p.manager_id, m.name AS manager_name, m.employee_code AS manager_code,
         p.start_date, p.end_date, p.created_at, p.updated_at,
         COALESCE(mem.member_count, 0) AS member_count,
         COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id), 0) AS task_count,
         COALESCE(mem.members, '[]'::json) AS members
  FROM projects p
  JOIN employees m ON m.id = p.manager_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS member_count,
           json_agg(json_build_object(
             'id', e.id, 'name', e.name, 'employee_code', e.employee_code,
             'department', e.department, 'job_title', e.job_title
           ) ORDER BY e.name) AS members
    FROM project_members pm
    JOIN employees e ON e.id = pm.employee_id
    WHERE pm.project_id = p.id
  ) mem ON true
`;

// GET /api/projects?department=Marketing&status=open — every project (all
// authenticated users can see the company-wide board).
router.get('/', requireAuth, wrap(async (req, res) => {
  const { department, status } = req.query;
  const clauses = [];
  const params = [];
  if (department && department !== 'all') {
    params.push(department);
    clauses.push(`p.department = $${params.length}`);
  }
  if (status && VALID_STATUS.includes(status)) {
    params.push(status);
    clauses.push(`p.status = $${params.length}`);
  }
  // ?mine=1 → only projects the caller is a member of (the "My Projects" view).
  if (req.query.mine === '1' || req.query.mine === 'true') {
    params.push(req.user.id);
    clauses.push(`p.id IN (SELECT project_id FROM project_members WHERE employee_id = $${params.length})`);
  } else if (req.user.accessRole !== 'admin') {
    // Only admins see the whole company board. A manager sees the projects they
    // manage; anyone else sees the projects they belong to.
    params.push(req.user.id);
    if (req.user.accessRole === 'manager') {
      clauses.push(`p.manager_id = $${params.length}`);
    } else {
      clauses.push(`p.id IN (SELECT project_id FROM project_members WHERE employee_id = $${params.length})`);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await db.query(
    `${PROJECT_SELECT} ${where} ORDER BY p.updated_at DESC`,
    params
  );
  res.json({ projects: rows });
}));

// GET /api/projects/stats — counts by status for the dashboard tiles.
// Registered before '/:id' so "stats" isn't captured as a project id.
router.get('/stats', requireAuth, wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.mine === '1' || req.query.mine === 'true') {
    params.push(req.user.id);
    where = 'WHERE id IN (SELECT project_id FROM project_members WHERE employee_id = $1)';
  } else if (req.user.accessRole !== 'admin') {
    params.push(req.user.id);
    where = req.user.accessRole === 'manager'
      ? 'WHERE manager_id = $1'
      : 'WHERE id IN (SELECT project_id FROM project_members WHERE employee_id = $1)';
  }
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM projects ${where} GROUP BY status`,
    params
  );
  const stats = { open: 0, paused: 0, closed: 0, total: 0 };
  rows.forEach((r) => { stats[r.status] = r.count; stats.total += r.count; });
  res.json({ stats });
}));

// GET /api/projects/:id — one project with its members. Members can view their
// own projects; managers/admins can view any.
router.get('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(`${PROJECT_SELECT} WHERE p.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found.' });
  // Admins see any project; a manager only their own; others only ones they belong to.
  if (req.user.accessRole !== 'admin' && rows[0].manager_id !== req.user.id) {
    const { rows: m } = await db.query('SELECT 1 FROM project_members WHERE project_id = $1 AND employee_id = $2', [req.params.id, req.user.id]);
    if (!m.length) return res.status(403).json({ error: 'You are not a member of this project.' });
  }
  res.json({ project: rows[0] });
}));

// GET /api/projects/:id/history — activity log (members + managers/admins).
router.get('/:id/history', requireAuth, wrap(async (req, res) => {
  const { rows: exists } = await db.query('SELECT manager_id FROM projects WHERE id = $1', [req.params.id]);
  if (!exists[0]) return res.status(404).json({ error: 'Project not found.' });
  if (req.user.accessRole !== 'admin' && exists[0].manager_id !== req.user.id) {
    const { rows: m } = await db.query('SELECT 1 FROM project_members WHERE project_id = $1 AND employee_id = $2', [req.params.id, req.user.id]);
    if (!m.length) return res.status(403).json({ error: 'You are not a member of this project.' });
  }
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.detail, a.created_at, e.name AS actor
     FROM project_activity a LEFT JOIN employees e ON e.id = a.actor_id
     WHERE a.project_id = $1 ORDER BY a.created_at DESC LIMIT 200`,
    [req.params.id]
  );
  res.json({ history: rows });
}));

// POST /api/projects — only managers/admins can start a project; whoever
// creates it becomes the project manager automatically.
router.post('/', requireAuth, wrap(async (req, res) => {
  if (req.user.accessRole !== 'manager' && req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'Only managers or admins can create projects.' });
  }
  const { name, description, department, memberIds, startDate, endDate } = req.body || {};
  const priority = VALID_PRIORITY.includes(req.body?.priority) ? req.body.priority : 'none';
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name is required.' });
  if (!department || !department.trim()) return res.status(400).json({ error: 'Department is required.' });
  // Empty strings from the form become NULL (dates are optional).
  const start = startDate || null;
  const end = endDate || null;
  if (start && end && end < start) {
    return res.status(400).json({ error: 'Target end date cannot be before the start date.' });
  }

  const managerId = req.user.id;
  const ids = Array.isArray(memberIds)
    ? [...new Set(memberIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO projects (name, description, department, manager_id, created_by, start_date, end_date, priority)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7) RETURNING id`,
      [name.trim().slice(0, 200), (description || '').trim().slice(0, 4000), department.trim().slice(0, 100), managerId, start, end, priority]
    );
    const projectId = rows[0].id;

    // Always include the manager as a member, plus everyone selected.
    const memberSet = new Set([managerId, ...ids]);
    for (const empId of memberSet) {
      await client.query(
        `INSERT INTO project_members (project_id, employee_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [projectId, empId]
      );
    }
    await logActivity(client, projectId, managerId, 'created', `created project "${name.trim().slice(0, 200)}"`);
    await client.query('COMMIT');

    const { rows: full } = await db.query(`${PROJECT_SELECT} WHERE p.id = $1`, [projectId]);
    res.status(201).json({ project: full[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') return res.status(400).json({ error: 'One of the selected members does not exist.' });
    throw err;
  } finally {
    client.release();
  }
}));

// PATCH /api/projects/:id/status — only the project's manager or an admin can
// change its status (open / paused / closed).
router.patch('/:id/status', requireAuth, wrap(async (req, res) => {
  const { status } = req.body || {};
  if (!VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: 'Status must be open, paused, or closed.' });
  }
  const { rows } = await db.query('SELECT manager_id FROM projects WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found.' });
  if (rows[0].manager_id !== req.user.id && req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'Only the project manager or an admin can change the status.' });
  }
  await db.query('UPDATE projects SET status = $1, updated_at = now() WHERE id = $2', [status, req.params.id]);
  await logActivity(db, req.params.id, req.user.id, 'status', `changed status to ${status}`);
  const { rows: full } = await db.query(`${PROJECT_SELECT} WHERE p.id = $1`, [req.params.id]);
  res.json({ project: full[0] });
}));

// PATCH /api/projects/:id/priority — only the project's manager or an admin.
router.patch('/:id/priority', requireAuth, wrap(async (req, res) => {
  const { priority } = req.body || {};
  if (!VALID_PRIORITY.includes(priority)) {
    return res.status(400).json({ error: 'Priority must be none, low, medium, or high.' });
  }
  const { rows } = await db.query('SELECT manager_id FROM projects WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found.' });
  if (rows[0].manager_id !== req.user.id && req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'Only the project manager or an admin can change the priority.' });
  }
  await db.query('UPDATE projects SET priority = $1, updated_at = now() WHERE id = $2', [priority, req.params.id]);
  await logActivity(db, req.params.id, req.user.id, 'priority', `set priority to ${priority}`);
  const { rows: full } = await db.query(`${PROJECT_SELECT} WHERE p.id = $1`, [req.params.id]);
  res.json({ project: full[0] });
}));

// PATCH /api/projects/:id/manager — reassign the project manager. Admin only
// (fixes projects that were auto-reassigned to the acting admin when a previous
// manager's account was deleted). The new manager is added as a member.
router.patch('/:id/manager', requireAuth, wrap(async (req, res) => {
  if (req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can change the project manager.' });
  }
  const managerId = Number(req.body?.managerId);
  if (!Number.isInteger(managerId)) return res.status(400).json({ error: 'Pick a valid person.' });
  const { rows: exists } = await db.query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
  if (!exists[0]) return res.status(404).json({ error: 'Project not found.' });
  const { rows: emp } = await db.query('SELECT id, name FROM employees WHERE id = $1 AND is_active = true', [managerId]);
  if (!emp[0]) return res.status(400).json({ error: 'That employee does not exist.' });

  await db.query('UPDATE projects SET manager_id = $1, updated_at = now() WHERE id = $2', [managerId, req.params.id]);
  await db.query('INSERT INTO project_members (project_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, managerId]);
  await logActivity(db, req.params.id, req.user.id, 'manager', `changed the project manager to ${emp[0].name}`);
  const { rows: full } = await db.query(`${PROJECT_SELECT} WHERE p.id = $1`, [req.params.id]);
  res.json({ project: full[0] });
}));

// PATCH /api/projects/:id/members — manager or admin: replace the member list.
router.patch('/:id/members', requireAuth, wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.memberIds)
    ? [...new Set(req.body.memberIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  const { rows } = await db.query('SELECT manager_id FROM projects WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found.' });
  if (rows[0].manager_id !== req.user.id && req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'Only the project manager or an admin can change members.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM project_members WHERE project_id = $1', [req.params.id]);
    const memberSet = new Set([rows[0].manager_id, ...ids]);
    for (const empId of memberSet) {
      await client.query(
        `INSERT INTO project_members (project_id, employee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.params.id, empId]
      );
    }
    await logActivity(client, req.params.id, req.user.id, 'members', 'updated the team members');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const { rows: full } = await db.query(`${PROJECT_SELECT} WHERE p.id = $1`, [req.params.id]);
  res.json({ project: full[0] });
}));

// DELETE /api/projects/:id — the project's manager or an admin can permanently
// delete the project. Its tasks, memberships and activity cascade away.
router.delete('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query('SELECT manager_id, name FROM projects WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found.' });
  if (rows[0].manager_id !== req.user.id && req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'Only the project manager or an admin can delete this project.' });
  }
  await db.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
