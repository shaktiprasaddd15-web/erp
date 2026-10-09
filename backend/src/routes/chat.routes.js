const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendPushToEmployees } = require('../utils/push');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const dmKey = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;

// Ensure the single company-wide channel exists; return its id.
async function ensureCompanyChannel() {
  const { rows } = await db.query('SELECT id FROM conversations WHERE is_company = true LIMIT 1');
  if (rows[0]) return rows[0].id;
  const { rows: ins } = await db.query(
    `INSERT INTO conversations (type, title, is_company) VALUES ('channel', 'Company-wide', true)
     ON CONFLICT DO NOTHING RETURNING id`
  );
  if (ins[0]) return ins[0].id;
  const { rows: again } = await db.query('SELECT id FROM conversations WHERE is_company = true LIMIT 1');
  return again[0].id;
}

// Keep a user's channel memberships in sync with reality, lazily: the company
// channel (everyone) and one channel per project they belong to. Cheap enough
// to run when they open Chat.
async function syncMyChannels(userId) {
  const companyId = await ensureCompanyChannel();
  // Everyone active belongs to the company-wide channel.
  await db.query(
    `INSERT INTO conversation_members (conversation_id, employee_id)
     SELECT $1, id FROM employees WHERE is_active = true ON CONFLICT DO NOTHING`,
    [companyId]
  );
  // Projects the user is a member of.
  const { rows: projects } = await db.query(
    `SELECT p.id, p.name FROM projects p
     JOIN project_members pm ON pm.project_id = p.id AND pm.employee_id = $1`,
    [userId]
  );
  for (const p of projects) {
    let { rows: conv } = await db.query('SELECT id FROM conversations WHERE project_id = $1', [p.id]);
    let convId = conv[0] && conv[0].id;
    if (!convId) {
      const { rows: ins } = await db.query(
        `INSERT INTO conversations (type, title, project_id, created_by) VALUES ('channel', $1, $2, $3)
         ON CONFLICT (project_id) WHERE project_id IS NOT NULL DO NOTHING RETURNING id`,
        [p.name, p.id, userId]
      );
      convId = ins[0] ? ins[0].id : (await db.query('SELECT id FROM conversations WHERE project_id = $1', [p.id])).rows[0].id;
    }
    // Every current project member belongs to its channel.
    await db.query(
      `INSERT INTO conversation_members (conversation_id, employee_id)
       SELECT $1, pm.employee_id FROM project_members pm WHERE pm.project_id = $2 ON CONFLICT DO NOTHING`,
      [convId, p.id]
    );
  }
}

async function isMember(convId, userId) {
  const { rows } = await db.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND employee_id = $2',
    [convId, userId]
  );
  return rows.length > 0;
}

// GET /api/chat/conversations — my conversations with last message + unread count.
router.get('/conversations', requireAuth, wrap(async (req, res) => {
  await syncMyChannels(req.user.id);
  const { rows } = await db.query(
    `SELECT c.id, c.type, c.title, c.project_id, c.is_company, cm.last_read_at,
            p.name AS project_name,
            lm.body AS last_body, lm.created_at AS last_at, lm.sender_name,
            (SELECT COUNT(*)::int FROM messages m
               WHERE m.conversation_id = c.id AND m.created_at > cm.last_read_at AND m.sender_id <> $1) AS unread,
            (SELECT COUNT(*)::int FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count
     FROM conversation_members cm
     JOIN conversations c ON c.id = cm.conversation_id
     LEFT JOIN projects p ON p.id = c.project_id
     LEFT JOIN LATERAL (
       SELECT m.body, m.created_at, e.name AS sender_name
       FROM messages m LEFT JOIN employees e ON e.id = m.sender_id
       WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
     ) lm ON true
     WHERE cm.employee_id = $1
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC`,
    [req.user.id]
  );

  // For DMs, resolve the other participant's name/id.
  const dmIds = rows.filter((r) => r.type === 'dm').map((r) => r.id);
  const otherByConv = {};
  if (dmIds.length) {
    const { rows: others } = await db.query(
      `SELECT cm.conversation_id, e.id, e.name, e.job_title
       FROM conversation_members cm JOIN employees e ON e.id = cm.employee_id
       WHERE cm.conversation_id = ANY($1) AND cm.employee_id <> $2`,
      [dmIds, req.user.id]
    );
    others.forEach((o) => { otherByConv[o.conversation_id] = o; });
  }

  const conversations = rows.map((r) => {
    let name, subtitle;
    if (r.type === 'dm') {
      const o = otherByConv[r.id];
      name = o ? o.name : 'Direct message';
      subtitle = o ? (o.job_title || 'Direct message') : 'Direct message';
    } else if (r.is_company) {
      name = 'Company-wide';
      subtitle = `${r.member_count} members · announcements`;
    } else {
      name = r.project_name || r.title || 'Channel';
      subtitle = `${r.member_count} members · project channel`;
    }
    return {
      id: r.id, type: r.type, is_company: r.is_company, project_id: r.project_id,
      name, subtitle, member_count: r.member_count,
      last_body: r.last_body, last_at: r.last_at, last_sender: r.sender_name,
      unread: r.unread,
      other_id: otherByConv[r.id] ? otherByConv[r.id].id : null,
    };
  });
  res.json({ conversations });
}));

// GET /api/chat/unread — total unread, for the nav badge.
router.get('/unread', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(u), 0)::int AS total FROM (
       SELECT (SELECT COUNT(*) FROM messages m
                 WHERE m.conversation_id = cm.conversation_id
                   AND m.created_at > cm.last_read_at AND m.sender_id <> $1) AS u
       FROM conversation_members cm WHERE cm.employee_id = $1
     ) s`,
    [req.user.id]
  );
  res.json({ unread: rows[0].total });
}));

// GET /api/chat/conversations/:id/messages?after=<id> — thread (polling-friendly).
// Opening/polling a conversation marks it read for the caller. Members only,
// except admins may read any channel (compliance), not private DMs.
router.get('/conversations/:id/messages', requireAuth, wrap(async (req, res) => {
  const { rows: conv } = await db.query('SELECT id, type FROM conversations WHERE id = $1', [req.params.id]);
  if (!conv[0]) return res.status(404).json({ error: 'Conversation not found.' });
  const member = await isMember(req.params.id, req.user.id);
  const adminChannelPeek = req.user.accessRole === 'admin' && conv[0].type === 'channel';
  if (!member && !adminChannelPeek) return res.status(403).json({ error: 'Not allowed.' });

  const after = req.query.after ? Number(req.query.after) : null;
  const params = [req.params.id];
  let afterClause = '';
  if (after) { params.push(after); afterClause = ` AND m.id > $${params.length}`; }
  const { rows } = await db.query(
    `SELECT m.id, m.body, m.mentions, m.created_at, m.sender_id, e.name AS sender_name
     FROM messages m LEFT JOIN employees e ON e.id = m.sender_id
     WHERE m.conversation_id = $1${afterClause}
     ORDER BY m.created_at ASC LIMIT 500`,
    params
  );
  // Mark read for actual members.
  if (member) {
    await db.query('UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND employee_id = $2', [req.params.id, req.user.id]);
  }
  res.json({ messages: rows, readonly: !member });
}));

// POST /api/chat/conversations/:id/messages { body, mentions? } — members only.
router.post('/conversations/:id/messages', requireAuth, wrap(async (req, res) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write a message.' });
  if (!(await isMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'Only members can message here.' });

  // Mentions: keep only ids that are members of this conversation.
  let mentions = Array.isArray(req.body?.mentions) ? req.body.mentions.map(Number).filter(Number.isInteger) : [];
  mentions = [...new Set(mentions)].slice(0, 30);
  if (mentions.length) {
    const { rows: valid } = await db.query(
      'SELECT employee_id FROM conversation_members WHERE conversation_id = $1 AND employee_id = ANY($2)',
      [req.params.id, mentions]
    );
    mentions = valid.map((r) => r.employee_id);
  }

  const { rows } = await db.query(
    `INSERT INTO messages (conversation_id, sender_id, body, mentions) VALUES ($1,$2,$3,$4)
     RETURNING id, body, mentions, created_at, sender_id`,
    [req.params.id, req.user.id, body.slice(0, 4000), mentions]
  );
  await db.query('UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND employee_id = $2', [req.params.id, req.user.id]);

  // Push to the other members (best-effort); mentioned people get a sharper nudge.
  try {
    const { rows: members } = await db.query(
      'SELECT employee_id FROM conversation_members WHERE conversation_id = $1 AND employee_id <> $2',
      [req.params.id, req.user.id]
    );
    const targets = members.map((m) => m.employee_id);
    if (targets.length) {
      await sendPushToEmployees(targets, {
        title: `New message from ${req.user.name}`,
        body: body.slice(0, 120),
        url: '/',
      });
    }
  } catch (e) { /* best-effort */ }

  res.status(201).json({ message: { ...rows[0], sender_name: req.user.name } });
}));

// POST /api/chat/dm { userId } — get or create a 1:1 DM with that person.
router.post('/dm', requireAuth, wrap(async (req, res) => {
  const otherId = Number(req.body?.userId);
  if (!Number.isInteger(otherId) || otherId === req.user.id) return res.status(400).json({ error: 'Pick a valid person.' });
  const { rows: emp } = await db.query('SELECT id, name FROM employees WHERE id = $1 AND is_active = true', [otherId]);
  if (!emp[0]) return res.status(404).json({ error: 'Person not found.' });

  const key = dmKey(req.user.id, otherId);
  const { rows: existing } = await db.query('SELECT id FROM conversations WHERE dm_key = $1', [key]);
  let convId = existing[0] && existing[0].id;
  if (!convId) {
    const { rows: ins } = await db.query(
      `INSERT INTO conversations (type, dm_key, created_by) VALUES ('dm', $1, $2)
       ON CONFLICT (dm_key) DO NOTHING RETURNING id`,
      [key, req.user.id]
    );
    convId = ins[0] ? ins[0].id : (await db.query('SELECT id FROM conversations WHERE dm_key = $1', [key])).rows[0].id;
    await db.query(
      `INSERT INTO conversation_members (conversation_id, employee_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`,
      [convId, req.user.id, otherId]
    );
  }
  res.json({ id: convId });
}));

// POST /api/chat/conversations/:id/read — mark read (used when opening).
router.post('/conversations/:id/read', requireAuth, wrap(async (req, res) => {
  await db.query('UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND employee_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// POST /api/chat/messages/:id/report { reason } — flag a message to the admins.
router.post('/messages/:id/report', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.id, m.body, m.conversation_id, e.name AS sender
     FROM messages m LEFT JOIN employees e ON e.id = m.sender_id WHERE m.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Message not found.' });
  const msg = rows[0];
  // Only someone who can see the message may report it.
  const member = await isMember(msg.conversation_id, req.user.id);
  if (!member && req.user.accessRole !== 'admin') return res.status(403).json({ error: 'Not allowed.' });
  const reason = (req.body?.reason || '').toString().trim().slice(0, 500);
  try {
    await db.query(
      'INSERT INTO audit_log (actor_employee_id, action, target, ip_address) VALUES ($1,$2,$3,$4)',
      [req.user.id, 'chat_message_reported', String(msg.id), req.ip]
    );
    const { rows: admins } = await db.query("SELECT id FROM employees WHERE access_role = 'admin' AND is_active = true");
    await sendPushToEmployees(admins.map((a) => a.id).filter((id) => id !== req.user.id), {
      title: 'A chat message was reported',
      body: `${req.user.name} reported a message from ${msg.sender || 'someone'}.`,
    });
  } catch (e) { /* best-effort */ }
  res.json({ ok: true });
}));

module.exports = router;
