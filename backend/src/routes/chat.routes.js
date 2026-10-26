const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
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

// Keep a user's channel memberships in sync with reality
async function syncMyChannels(userId) {
  const companyId = await ensureCompanyChannel();
  await db.query(
    `INSERT INTO conversation_members (conversation_id, employee_id)
     SELECT $1, id FROM employees WHERE is_active = true ON CONFLICT DO NOTHING`,
    [companyId]
  );
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

// Helper to query reactions for a list of message IDs
async function getReactionsMap(messageIds, userId) {
  if (!messageIds.length) return {};
  const { rows } = await db.query(
    `SELECT message_id, emoji, COUNT(*)::int AS count,
            BOOL_OR(employee_id = $2) AS has_me
     FROM message_reactions
     WHERE message_id = ANY($1)
     GROUP BY message_id, emoji
     ORDER BY count DESC, emoji ASC`,
    [messageIds, userId]
  );
  const map = {};
  rows.forEach((r) => {
    if (!map[r.message_id]) map[r.message_id] = [];
    map[r.message_id].push({ emoji: r.emoji, count: r.count, has_me: r.has_me });
  });
  return map;
}

// GET /api/chat/conversations — my conversations with last message, unread, and member presence
router.get('/conversations', requireAuth, wrap(async (req, res) => {
  await syncMyChannels(req.user.id);
  const { rows } = await db.query(
    `SELECT c.id, c.type, c.title, c.project_id, c.is_company, cm.last_read_at,
            p.name AS project_name,
            lm.body AS last_body, lm.created_at AS last_at, lm.sender_name, lm.deleted_at AS last_deleted,
            (SELECT COUNT(*)::int FROM messages m
               WHERE m.conversation_id = c.id AND m.created_at > cm.last_read_at AND m.sender_id <> $1 AND m.deleted_at IS NULL) AS unread,
            (SELECT COUNT(*)::int FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count
     FROM conversation_members cm
     JOIN conversations c ON c.id = cm.conversation_id
     LEFT JOIN projects p ON p.id = c.project_id
     LEFT JOIN LATERAL (
       SELECT m.body, m.created_at, m.deleted_at, e.name AS sender_name
       FROM messages m LEFT JOIN employees e ON e.id = m.sender_id
       WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
     ) lm ON true
     WHERE cm.employee_id = $1
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC`,
    [req.user.id]
  );

  const dmIds = rows.filter((r) => r.type === 'dm').map((r) => r.id);
  const otherByConv = {};
  if (dmIds.length) {
    const { rows: others } = await db.query(
      `SELECT cm.conversation_id, e.id, e.name, e.job_title, e.department, e.last_seen_at,
              (e.last_seen_at IS NOT NULL AND e.last_seen_at > now() - INTERVAL '5 minutes') AS is_online
       FROM conversation_members cm JOIN employees e ON e.id = cm.employee_id
       WHERE cm.conversation_id = ANY($1) AND cm.employee_id <> $2`,
      [dmIds, req.user.id]
    );
    others.forEach((o) => { otherByConv[o.conversation_id] = o; });
  }

  const conversations = rows.map((r) => {
    let name, subtitle, isOnline = false, otherId = null;
    if (r.type === 'dm') {
      const o = otherByConv[r.id];
      name = o ? o.name : 'Direct message';
      subtitle = o ? (o.job_title || o.department || 'Direct message') : 'Direct message';
      isOnline = o ? !!o.is_online : false;
      otherId = o ? o.id : null;
    } else if (r.is_company) {
      name = 'Company-wide';
      subtitle = `${r.member_count} members · announcements`;
    } else {
      name = r.project_name || r.title || 'Channel';
      subtitle = `${r.member_count} members · project channel`;
    }

    const lastPreview = r.last_deleted
      ? '🚫 Message deleted'
      : (r.last_body || '');

    return {
      id: r.id, type: r.type, is_company: r.is_company, project_id: r.project_id,
      name, subtitle, member_count: r.member_count,
      last_body: lastPreview, last_at: r.last_at, last_sender: r.sender_name,
      unread: r.unread,
      other_id: otherId,
      is_online: isOnline,
    };
  });
  res.json({ conversations });
}));

// GET /api/chat/unread — total unread for nav badge
router.get('/unread', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(u), 0)::int AS total FROM (
       SELECT (SELECT COUNT(*) FROM messages m
                 WHERE m.conversation_id = cm.conversation_id
                   AND m.created_at > cm.last_read_at AND m.sender_id <> $1 AND m.deleted_at IS NULL) AS u
       FROM conversation_members cm WHERE cm.employee_id = $1
     ) s`,
    [req.user.id]
  );
  res.json({ unread: rows[0].total });
}));

// GET /api/chat/conversations/:id/messages?after=<id>
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

  const { rows: msgs } = await db.query(
    `SELECT m.id,
            CASE WHEN m.deleted_at IS NOT NULL THEN '🚫 This message was deleted' ELSE m.body END AS body,
            m.mentions, m.created_at, m.edited_at, m.deleted_at, m.sender_id,
            m.reply_to_id, m.is_pinned,
            e.name AS sender_name,
            rm.body AS reply_body, rm.deleted_at AS reply_deleted_at,
            re.name AS reply_sender_name
     FROM messages m
     LEFT JOIN employees e ON e.id = m.sender_id
     LEFT JOIN messages rm ON rm.id = m.reply_to_id
     LEFT JOIN employees re ON re.id = rm.sender_id
     WHERE m.conversation_id = $1${afterClause}
     ORDER BY m.created_at ASC LIMIT 500`,
    params
  );

  const messageIds = msgs.map((m) => m.id);
  const reactionsMap = await getReactionsMap(messageIds, req.user.id);

  const processed = msgs.map((m) => {
    let replyPreview = null;
    if (m.reply_to_id) {
      replyPreview = {
        id: m.reply_to_id,
        sender_name: m.reply_sender_name || 'Someone',
        body: m.reply_deleted_at ? '🚫 Message deleted' : (m.reply_body ? m.reply_body.slice(0, 100) : 'Message'),
      };
    }
    return {
      id: m.id,
      body: m.body,
      mentions: m.mentions,
      created_at: m.created_at,
      edited_at: m.edited_at,
      deleted_at: m.deleted_at,
      sender_id: m.sender_id,
      sender_name: m.sender_name,
      reply_to: replyPreview,
      is_pinned: !!m.is_pinned,
      reactions: reactionsMap[m.id] || [],
    };
  });

  if (member) {
    await db.query('UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND employee_id = $2', [req.params.id, req.user.id]);
  }
  res.json({ messages: processed, readonly: !member });
}));

// POST /api/chat/conversations/:id/messages { body, mentions?, replyToId? }
router.post('/conversations/:id/messages', requireAuth, wrap(async (req, res) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write a message.' });
  if (!(await isMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'Only members can message here.' });

  const replyToId = req.body?.replyToId ? Number(req.body.replyToId) : null;
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
    `INSERT INTO messages (conversation_id, sender_id, body, mentions, reply_to_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, body, mentions, created_at, sender_id, reply_to_id, is_pinned`,
    [req.params.id, req.user.id, body.slice(0, 4000), mentions, replyToId]
  );
  await db.query('UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND employee_id = $2', [req.params.id, req.user.id]);

  let replyPreview = null;
  if (replyToId) {
    const { rows: rep } = await db.query(
      `SELECT m.id, m.body, m.deleted_at, e.name AS sender_name
       FROM messages m LEFT JOIN employees e ON e.id = m.sender_id WHERE m.id = $1`,
      [replyToId]
    );
    if (rep[0]) {
      replyPreview = {
        id: rep[0].id,
        sender_name: rep[0].sender_name || 'Someone',
        body: rep[0].deleted_at ? '🚫 Message deleted' : (rep[0].body ? rep[0].body.slice(0, 100) : 'Message'),
      };
    }
  }

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

  res.status(201).json({
    message: {
      ...rows[0],
      sender_name: req.user.name,
      reply_to: replyPreview,
      reactions: [],
    },
  });
}));

// PATCH /api/chat/messages/:id — edit own message
router.patch('/messages/:id', requireAuth, wrap(async (req, res) => {
  const newBody = (req.body?.body || '').trim();
  if (!newBody) return res.status(400).json({ error: 'Message cannot be empty.' });

  const { rows } = await db.query(
    'SELECT id, sender_id, conversation_id, deleted_at FROM messages WHERE id = $1',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Message not found.' });
  if (rows[0].deleted_at) return res.status(400).json({ error: 'Cannot edit a deleted message.' });
  if (rows[0].sender_id !== req.user.id && req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'You can only edit your own messages.' });
  }

  const { rows: updated } = await db.query(
    `UPDATE messages
     SET body = $1, edited_at = now()
     WHERE id = $2
     RETURNING id, body, edited_at`,
    [newBody.slice(0, 4000), req.params.id]
  );
  res.json({ message: updated[0] });
}));

// DELETE /api/chat/messages/:id — soft delete with tombstone
router.delete('/messages/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, sender_id, conversation_id, deleted_at FROM messages WHERE id = $1',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Message not found.' });
  if (rows[0].deleted_at) return res.json({ ok: true }); // already deleted
  if (rows[0].sender_id !== req.user.id && req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'You can only delete your own messages.' });
  }

  await db.query(
    `UPDATE messages
     SET deleted_at = now(), deleted_by = $1, body = ''
     WHERE id = $2`,
    [req.user.id, req.params.id]
  );
  res.json({ ok: true, id: Number(req.params.id) });
}));

// POST /api/chat/messages/:id/react { emoji } — toggle reaction (Teams-style)
router.post('/messages/:id/react', requireAuth, wrap(async (req, res) => {
  const emoji = (req.body?.emoji || '').trim();
  const ALLOWED_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '👏', '🎉', '🔥'];
  if (!ALLOWED_EMOJIS.includes(emoji)) {
    return res.status(400).json({ error: 'Invalid reaction emoji.' });
  }

  const { rows: msg } = await db.query('SELECT conversation_id, deleted_at FROM messages WHERE id = $1', [req.params.id]);
  if (!msg[0]) return res.status(404).json({ error: 'Message not found.' });
  if (msg[0].deleted_at) return res.status(400).json({ error: 'Cannot react to a deleted message.' });
  if (!(await isMember(msg[0].conversation_id, req.user.id))) return res.status(403).json({ error: 'Not allowed.' });

  // Toggle: delete if exists, else insert
  const { rowCount } = await db.query(
    'DELETE FROM message_reactions WHERE message_id = $1 AND employee_id = $2 AND emoji = $3',
    [req.params.id, req.user.id, emoji]
  );
  if (rowCount === 0) {
    await db.query(
      `INSERT INTO message_reactions (message_id, employee_id, emoji)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id, emoji]
    );
  }

  const reactionsMap = await getReactionsMap([req.params.id], req.user.id);
  res.json({ reactions: reactionsMap[req.params.id] || [] });
}));

// POST /api/chat/messages/:id/pin — toggle pinned state
router.post('/messages/:id/pin', requireAuth, wrap(async (req, res) => {
  const { rows: msg } = await db.query('SELECT id, conversation_id, is_pinned, deleted_at FROM messages WHERE id = $1', [req.params.id]);
  if (!msg[0]) return res.status(404).json({ error: 'Message not found.' });
  if (msg[0].deleted_at) return res.status(400).json({ error: 'Cannot pin a deleted message.' });
  if (!(await isMember(msg[0].conversation_id, req.user.id)) && req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'Not allowed.' });
  }

  const nextPinned = !msg[0].is_pinned;
  await db.query(
    `UPDATE messages
     SET is_pinned = $1,
         pinned_at = CASE WHEN $1 = true THEN now() ELSE NULL END,
         pinned_by = CASE WHEN $1 = true THEN $2::int ELSE NULL END
     WHERE id = $3`,
    [nextPinned, Number(req.user.id), req.params.id]
  );
  res.json({ is_pinned: nextPinned });
}));

// GET /api/chat/conversations/:id/pinned — list pinned messages
router.get('/conversations/:id/pinned', requireAuth, wrap(async (req, res) => {
  if (!(await isMember(req.params.id, req.user.id)) && req.user.accessRole !== 'admin') {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const { rows } = await db.query(
    `SELECT m.id, m.body, m.created_at, e.name AS sender_name, m.pinned_at
     FROM messages m
     LEFT JOIN employees e ON e.id = m.sender_id
     WHERE m.conversation_id = $1 AND m.is_pinned = true AND m.deleted_at IS NULL
     ORDER BY m.pinned_at DESC`,
    [req.params.id]
  );
  res.json({ pinned: rows });
}));

// POST /api/chat/dm { userId }
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

// POST /api/chat/conversations/:id/read
router.post('/conversations/:id/read', requireAuth, wrap(async (req, res) => {
  await db.query('UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND employee_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// POST /api/chat/messages/:id/report { reason }
router.post('/messages/:id/report', requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.id, m.body, m.conversation_id, e.name AS sender
     FROM messages m LEFT JOIN employees e ON e.id = m.sender_id WHERE m.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Message not found.' });
  const msg = rows[0];
  const member = await isMember(msg.conversation_id, req.user.id);
  if (!member && req.user.accessRole !== 'admin') return res.status(403).json({ error: 'Not allowed.' });
  const reason = (req.body?.reason || '').toString().trim().slice(0, 500);

  await db.query(
    `INSERT INTO message_reports (message_id, reporter_id, reason, status)
     VALUES ($1, $2, $3, 'open')
     ON CONFLICT (message_id, reporter_id) DO UPDATE SET reason = $3, status = 'open'`,
    [msg.id, req.user.id, reason]
  );

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
