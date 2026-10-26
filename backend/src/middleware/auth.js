const jwt = require('jsonwebtoken');
const db = require('../db');

// Returns the currently-active temporary access grant for an employee, or null.
async function activeGrant(employeeId) {
  try {
    const { rows } = await db.query(
      `SELECT granted_role, expires_at FROM access_grants
       WHERE employee_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [employeeId]
    );
    return rows[0] || null;
  } catch (e) {
    return null;   // table may not exist yet / transient error → fall back to base role
  }
}

// Verifies the JWT sent in Authorization: Bearer <token> and attaches the
// decoded payload to req.user. The access role stored in the token is the
// BASE role; if the user holds an active temporary grant we override
// req.user.accessRole with the elevated role for this request.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
  req.user = payload;
  req.user.baseRole = payload.accessRole;

  // Background presence tracking: update last_seen_at (fire-and-forget)
  db.query('UPDATE employees SET last_seen_at = now() WHERE id = $1', [payload.id]).catch(() => {});

  const grant = await activeGrant(payload.id);
  if (grant) {
    req.user.accessRole = grant.granted_role;
    req.user.tempAccess = { role: grant.granted_role, expiresAt: grant.expires_at };
  }
  next();
}

// Restricts a route to specific access roles, e.g. requireRole('manager', 'admin')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.accessRole)) {
      return res.status(403).json({ error: 'You do not have permission to access this resource.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, activeGrant };
