#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function requireMatch(label, text, pattern) {
  if (!pattern.test(text)) failures.push(`${label}: missing ${pattern}`);
}

const docs = read('docs/RBAC.md');
const index = read('index.html');
const tests = read('tests/e2e/app-shell.spec.js');
const createUser = read('supabase/functions/create-user/index.ts');
const adminOps = read('supabase/functions/admin-ops/index.ts');
const sql = read('docs/sql/05-admin-mfa-aal2-hardening.sql');

for (const role of ['superuser', 'admin', 'user']) {
  requireMatch('docs/RBAC.md', docs, new RegExp(`\\b${role}\\b`, 'i'));
}
requireMatch('docs/RBAC.md', docs, /app_metadata\.role/);
requireMatch('docs/RBAC.md', docs, /aal2/);
requireMatch('docs/RBAC.md', docs, /create-user/);
requireMatch('docs/RBAC.md', docs, /admin-ops/);

requireMatch('index.html', index, /function\s+_isAdminOrSU\(/);
requireMatch('index.html', index, /function\s+_adminOnly\(/);
requireMatch('tests/e2e/app-shell.spec.js', tests, /role matrix allows only admin and superuser/);

requireMatch('create-user', createUser, /Only a superuser can grant the superuser role/);
requireMatch('create-user', createUser, /Only a superuser can create another superuser account/);
requireMatch('create-user', createUser, /mfa_required/);
requireMatch('admin-ops', adminOps, /restore-backup/);
requireMatch('admin-ops', adminOps, /mfa_required/);

requireMatch('05-admin-mfa-aal2-hardening.sql', sql, /radscheduler_admin_aal2/);
requireMatch('05-admin-mfa-aal2-hardening.sql', sql, /radscheduler_non_admin_same_practice/);

if (failures.length) {
  console.error('RBAC matrix check failed:');
  console.error(failures.map(f => `- ${f}`).join('\n'));
  process.exit(1);
}

console.log('RBAC matrix check passed');
