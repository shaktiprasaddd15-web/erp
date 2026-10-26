require('dotenv').config();
const { pool } = require('../src/db');

async function testConnection() {
  console.log('Testing database connection...');
  const startTime = Date.now();
  
  try {
    const client = await pool.connect();
    const duration = Date.now() - startTime;
    console.log(`Connected successfully in ${duration}ms!`);

    const res = await client.query(`
      SELECT 
        version(), 
        current_database() as db_name, 
        current_user as user_name,
        inet_server_addr() as server_ip,
        current_setting('ssl', true) as ssl_active
    `);
    
    const info = res.rows[0];
    console.log('\n--- Database Connection Info ---');
    console.log(`Database:     ${info.db_name}`);
    console.log(`User:         ${info.user_name}`);
    console.log(`SSL Active:   ${info.ssl_active || 'yes'}`);
    console.log(`Version:      ${info.version.split(',')[0]}`);

    // Check existing tables count
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    
    console.log(`\nExisting Tables in 'public' schema (${tablesRes.rows.length}):`);
    if (tablesRes.rows.length === 0) {
      console.log('  (No tables found yet. Run "npm run migrate" to initialize schema.)');
    } else {
      console.log('  ' + tablesRes.rows.map(r => r.table_name).join(', '));
    }

    client.release();
    console.log('\nConnection test passed.');
    process.exit(0);
  } catch (err) {
    console.error('\nDatabase connection test failed:');
    console.error(err.message);
    if (err.message.includes('password authentication failed')) {
      console.error('Check your user and password credentials in DATABASE_URL.');
    } else if (err.message.includes('timeout')) {
      console.error('Connection timed out. If using Neon, ensure the compute endpoint is active or check network/firewall.');
    } else if (err.message.includes('SSL')) {
      console.error('SSL negotiation error. Neon requires SSL (ensure DB_SSL is not set to "false").');
    }
    process.exit(1);
  }
}

testConnection();
