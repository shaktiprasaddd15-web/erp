const { Pool } = require('pg');
const types = require('pg').types;

// Postgres DATE columns (OID 1082) come back from node-postgres as JS Date
// objects by default, which silently corrupts day-string comparisons
// (e.g. "2026-08-20" vs a Date's default toString()) and breaks the
// frontend's date formatting. Force them to stay as plain 'YYYY-MM-DD' strings.
types.setTypeParser(1082, (val) => val);

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Copy .env.example to .env and configure it.');
  process.exit(1);
}

// Managed cloud providers (Neon, Supabase, RDS) require SSL.
// Neon connection strings (neon.tech) require SSL. A self-hosted
// Postgres (e.g. in Docker Compose, or on the same VPS) usually doesn't have
// SSL configured at all, so set DB_SSL=false explicitly in that case.
// DB_SSL is opt-out: anything other than the literal string "false" enables SSL.
const useSSL = process.env.DB_SSL !== 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  // Neon serverless compute instances suspend when idle. Allow up to 15s
  // for Neon compute auto-resume (cold start) during connection acquisition.
  connectionTimeoutMillis: 15000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
