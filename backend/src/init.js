const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('./db');

// Runs every .sql file in migrations/ in filename order. All migrations use
// CREATE TABLE IF NOT EXISTS / idempotent statements, so this is safe to run
// on every boot.
async function runMigrations() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await db.query(sql);
    console.log(`migration applied: ${file}`);
  }
}

// Seeds a bootstrap admin ONLY on a database that has no admin yet, so the app
// is usable on a fresh install. This is a true one-time seed: once a real admin
// account exists, this does nothing on subsequent boots — it never recreates or
// password-resets a fixed account. That lets a real admin permanently replace
// the bootstrap one, and a deleted default stays deleted (previously the fixed
// ADMIN-001 / '2005' account was re-upserted on every boot, which is exactly the
// credential-bypass risk we're closing here).
async function ensureAdmin() {
  const { rows } = await db.query(
    "SELECT 1 FROM employees WHERE access_role = 'admin' AND is_active = true LIMIT 1"
  );
  if (rows[0]) {
    console.log('admin present — bootstrap seed skipped');
    return;
  }

  // No admin exists — seed one. Credentials come from env; if ADMIN_PASSWORD is
  // not set we generate a strong random one and print it ONCE to the logs
  // (never a hardcoded default), and force a reset on first login.
  const email = (process.env.ADMIN_EMAIL || 'satvikk@rush.local').toLowerCase().trim();
  const name = process.env.ADMIN_NAME || 'Satvikk';
  const code = process.env.ADMIN_CODE || 'ADMIN-001';
  const envPw = process.env.ADMIN_PASSWORD;
  const password = envPw || crypto.randomBytes(12).toString('base64url');
  const hash = await bcrypt.hash(password, 12);

  await db.query(
    `INSERT INTO employees (employee_code, name, email, password_hash, department, job_title, access_role, must_reset_pw)
     VALUES ($1, $2, $3, $4, 'Administration', 'System Administrator', 'admin', true)
     ON CONFLICT (email) DO UPDATE
       SET access_role = 'admin', is_active = true, updated_at = now()`,
    [code, name, email, hash]
  );
  if (envPw) {
    console.log(`bootstrap admin seeded from env: ${email} (reset required on first login)`);
  } else {
    console.log(`bootstrap admin seeded: ${email} — one-time password: ${password} — change it on first login`);
  }
}

async function initDb() {
  await runMigrations();
  await ensureAdmin();
}

module.exports = { initDb, runMigrations, ensureAdmin };
