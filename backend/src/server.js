require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth.routes');
const entriesRoutes = require('./routes/entries.routes');
const employeesRoutes = require('./routes/employees.routes');
const reportsRoutes = require('./routes/reports.routes');
const projectsRoutes = require('./routes/projects.routes');
const tasksRoutes = require('./routes/tasks.routes');
const leavesRoutes = require('./routes/leaves.routes');
const accessRoutes = require('./routes/access.routes');
const pushRoutes = require('./routes/push.routes');
const remarksRoutes = require('./routes/remarks.routes');
const chatRoutes = require('./routes/chat.routes');
const { initDb } = require('./init');

// A rejected promise in an async route handler isn't caught by Express 4's
// error middleware; without this guard one transient DB error would crash the
// whole process. Log and keep serving instead.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const app = express();

// Trust the hosting platform's reverse proxy (Render/Railway/etc sit behind one)
// so req.ip and rate limiting work correctly.
app.set('trust proxy', 1);

app.use(helmet());
app.use(express.json({ limit: '200kb' })); // small cap — this app doesn't need big payloads

const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      // allow same-origin/non-browser tools (no origin header) and whitelisted origins
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

// Generic API-wide rate limit as a safety net (login has its own stricter limit).
// Keyed by the caller's bearer token when signed in, else by IP. This matters
// because a whole office often shares one public IP (NAT) — keying purely by IP
// would make ~60 employees share a single budget and throttle each other. Each
// signed-in user now gets their own budget regardless of shared IP.
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.headers.authorization ? 'tok:' + req.headers.authorization : req.ip),
  })
);

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/entries', entriesRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/leaves', leavesRoutes);
app.use('/api/access', accessRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/remarks', remarksRoutes);
app.use('/api/chat', chatRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// central error handler — never leak stack traces to clients
app.use((err, req, res, next) => {
  console.error(err);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 4000;

// Bring the schema up to date and guarantee the bootstrap admin exists before
// serving traffic. A failure here is logged but doesn't stop the server from
// booting (e.g. so /health stays reachable while a DB issue is investigated).
initDb()
  .catch((err) => console.error('Database init failed (continuing to boot):', err.message))
  .finally(() => app.listen(PORT, () => console.log(`Rush ERP API listening on port ${PORT}`)));
