const BASE_URL = 'http://localhost:4000';

async function runTests() {
  console.log('==================================================');
  console.log('   RUSH ERP API END-TO-END TEST SUITE            ');
  console.log('   Connected to Neon PostgreSQL                  ');
  console.log('==================================================\n');

  let token = null;
  let adminId = null;
  let passedCount = 0;
  let totalCount = 0;

  function record(pass, msg) {
    totalCount++;
    if (pass) {
      passedCount++;
      console.log(` [PASS] ${msg}`);
    } else {
      console.error(` [FAIL] ${msg}`);
    }
  }

  // 1. Health check
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    record(res.ok && data.ok, `GET /health (Server time: ${data.time})`);
  } catch (err) {
    record(false, `GET /health error: ${err.message}`);
    process.exit(1);
  }

  // 2. Login as admin
  try {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@rush.local',
        password: 'ChangeMe_Immediately123!'
      })
    });
    const data = await res.json();
    if (res.ok && data.token && data.user) {
      token = data.token;
      adminId = data.user.id;
      record(true, `POST /api/auth/login - Logged in as: ${data.user.name} (Role: ${data.user.accessRole}, ID: ${adminId})`);
    } else {
      record(false, `POST /api/auth/login: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    record(false, `POST /api/auth/login error: ${err.message}`);
  }

  if (!token) {
    console.error('\nCannot continue authenticated tests without token.');
    process.exit(1);
  }

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // 3. Current user profile
  try {
    const res = await fetch(`${BASE_URL}/api/auth/me`, { headers: authHeaders });
    const data = await res.json();
    record(res.ok && data.user?.email === 'admin@rush.local', `GET /api/auth/me - Verified user: ${data.user?.email} (${data.user?.name})`);
  } catch (err) {
    record(false, `GET /api/auth/me error: ${err.message}`);
  }

  // 4. Employees list
  try {
    const res = await fetch(`${BASE_URL}/api/employees`, { headers: authHeaders });
    const data = await res.json();
    record(res.ok && Array.isArray(data.employees), `GET /api/employees - Count: ${data.employees?.length || 0} employee(s)`);
  } catch (err) {
    record(false, `GET /api/employees error: ${err.message}`);
  }

  // 5. Projects list & stats
  let projectId = null;
  try {
    const statsRes = await fetch(`${BASE_URL}/api/projects/stats`, { headers: authHeaders });
    const statsData = await statsRes.json();
    record(statsRes.ok, `GET /api/projects/stats - Total projects: ${statsData.stats?.total ?? 0}`);

    const createRes = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Neon DB Integration Test Project',
        description: 'Verifying end-to-end functionality on Neon PostgreSQL',
        department: 'Administration'
      })
    });
    const createData = await createRes.json();
    if (createRes.ok && createData.project) {
      projectId = createData.project.id;
      record(true, `POST /api/projects - Created project #${projectId}: "${createData.project.name}"`);
    } else {
      record(false, `POST /api/projects: ${JSON.stringify(createData)}`);
    }
  } catch (err) {
    record(false, `Projects test error: ${err.message}`);
  }

  // 6. Tasks creation & retrieval
  try {
    if (projectId && adminId) {
      const taskRes = await fetch(`${BASE_URL}/api/tasks`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          projectId: projectId,
          title: 'Verify Database Schema 024 Extensions',
          assigneeId: adminId,
          priority: 'high',
          details: 'Verify Neon operations on PostgreSQL 18'
        })
      });
      const taskData = await taskRes.json();
      if (taskRes.ok && taskData.task) {
        record(true, `POST /api/tasks - Created task #${taskData.task.id}: "${taskData.task.title}"`);
      } else {
        record(false, `POST /api/tasks: ${JSON.stringify(taskData)}`);
      }

      // Fetch tasks for project
      const listRes = await fetch(`${BASE_URL}/api/tasks?projectId=${projectId}`, { headers: authHeaders });
      const listData = await listRes.json();
      record(listRes.ok && listData.tasks?.length > 0, `GET /api/tasks?projectId=${projectId} - Retrieved ${listData.tasks?.length || 0} task(s)`);
    }
  } catch (err) {
    record(false, `Task test error: ${err.message}`);
  }

  // 7. Chat test (conversations endpoint)
  try {
    const convRes = await fetch(`${BASE_URL}/api/chat/conversations`, { headers: authHeaders });
    const convData = await convRes.json();
    record(convRes.ok && Array.isArray(convData.conversations), `GET /api/chat/conversations - Responsive (${convData.conversations?.length || 0} conversations)`);
  } catch (err) {
    record(false, `Chat test error: ${err.message}`);
  }

  // 8. Leaves endpoint
  try {
    const leaveRes = await fetch(`${BASE_URL}/api/leaves`, { headers: authHeaders });
    const leaveData = await leaveRes.json();
    record(leaveRes.ok, `GET /api/leaves - Leaves API responsive`);
  } catch (err) {
    record(false, `Leaves test error: ${err.message}`);
  }

  // 9. Remarks endpoint
  try {
    const remarksRes = await fetch(`${BASE_URL}/api/remarks/mine`, { headers: authHeaders });
    const remarksData = await remarksRes.json();
    record(remarksRes.ok, `GET /api/remarks/mine - Remarks API responsive (${remarksData.remarks?.length || 0} remarks)`);
  } catch (err) {
    record(false, `Remarks test error: ${err.message}`);
  }

  // 10. Frontend accessibility check
  try {
    const feRes = await fetch('http://localhost:8080/index.html');
    record(feRes.ok && feRes.status === 200, `Frontend Web Server (http://localhost:8080/index.html - HTTP ${feRes.status})`);
  } catch (err) {
    record(false, `Frontend test error: ${err.message}`);
  }

  console.log('\n==================================================');
  console.log(`   TEST RESULTS: ${passedCount}/${totalCount} PASSED`);
  if (passedCount === totalCount) {
    console.log('   ALL SYSTEMS OPERATIONAL (Neon PostgreSQL + API + Frontend)');
  }
  console.log('==================================================');
}

runTests();
