#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sqlDir = path.join(root, 'docs/sql');
const hardeningPath = path.join(sqlDir, '04-rls-advisor-hardening.sql');
const hardening = fs.readFileSync(hardeningPath, 'utf8');
const allSql = fs.readdirSync(sqlDir)
  .filter(name => name.endsWith('.sql'))
  .sort()
  .map(name => fs.readFileSync(path.join(sqlDir, name), 'utf8'))
  .join('\n\n');

const failures = [];

function requireMatch(scope, label, pattern) {
  if (!pattern.test(scope.text)) {
    failures.push(`${scope.name}: missing ${label}`);
  }
}

function rejectMatch(scope, label, pattern) {
  const match = scope.text.match(pattern);
  if (match) {
    const excerpt = match[0].replace(/\s+/g, ' ').slice(0, 160);
    failures.push(`${scope.name}: ${label}: ${excerpt}`);
  }
}

const hardeningScope = { name: 'docs/sql/04-rls-advisor-hardening.sql', text: hardening };
const allScope = { name: 'docs/sql/*.sql', text: allSql };
const hardeningSqlOnly = hardening
  .split(/\r?\n/)
  .filter(line => !line.trim().startsWith('--'))
  .join('\n');

const policyChecks = [
  ['practices_select_scoped policy', /CREATE\s+POLICY\s+practices_select_scoped\s+ON\s+public\.practices[\s\S]*?FOR\s+SELECT\s+TO\s+authenticated/i],
  ['practices_insert_privileged policy', /CREATE\s+POLICY\s+practices_insert_privileged\s+ON\s+public\.practices[\s\S]*?FOR\s+INSERT\s+TO\s+authenticated/i],
  ['practices_update_privileged policy', /CREATE\s+POLICY\s+practices_update_privileged\s+ON\s+public\.practices[\s\S]*?FOR\s+UPDATE\s+TO\s+authenticated/i],
  ['radscheduler_select_scoped policy', /CREATE\s+POLICY\s+radscheduler_select_scoped\s+ON\s+public\.radscheduler[\s\S]*?FOR\s+SELECT\s+TO\s+authenticated/i],
  ['radscheduler_insert_scoped policy', /CREATE\s+POLICY\s+radscheduler_insert_scoped\s+ON\s+public\.radscheduler[\s\S]*?FOR\s+INSERT\s+TO\s+authenticated/i],
  ['radscheduler_update_scoped policy', /CREATE\s+POLICY\s+radscheduler_update_scoped\s+ON\s+public\.radscheduler[\s\S]*?FOR\s+UPDATE\s+TO\s+authenticated/i],
  ['radscheduler_backups_select_scoped policy', /CREATE\s+POLICY\s+radscheduler_backups_select_scoped\s+ON\s+public\.radscheduler_backups[\s\S]*?FOR\s+SELECT\s+TO\s+authenticated/i],
  ['radscheduler_backups_insert_scoped policy', /CREATE\s+POLICY\s+radscheduler_backups_insert_scoped\s+ON\s+public\.radscheduler_backups[\s\S]*?FOR\s+INSERT\s+TO\s+authenticated/i],
  ['radscheduler_backups_update_scoped policy', /CREATE\s+POLICY\s+radscheduler_backups_update_scoped\s+ON\s+public\.radscheduler_backups[\s\S]*?FOR\s+UPDATE\s+TO\s+authenticated/i],
  ['radscheduler_backups_delete_scoped policy', /CREATE\s+POLICY\s+radscheduler_backups_delete_scoped\s+ON\s+public\.radscheduler_backups[\s\S]*?FOR\s+DELETE\s+TO\s+authenticated/i],
  ['shifts_insert_authed policy', /CREATE\s+POLICY\s+shifts_insert_authed[\s\S]*?ON\s+public\.radscheduler_shifts[\s\S]*?FOR\s+INSERT[\s\S]*?TO\s+authenticated/i],
  ['shifts_update_authed policy', /CREATE\s+POLICY\s+shifts_update_authed[\s\S]*?ON\s+public\.radscheduler_shifts[\s\S]*?FOR\s+UPDATE[\s\S]*?TO\s+authenticated/i],
  ['shifts_delete_authed policy', /CREATE\s+POLICY\s+shifts_delete_authed[\s\S]*?ON\s+public\.radscheduler_shifts[\s\S]*?FOR\s+DELETE[\s\S]*?TO\s+authenticated/i],
  ['shifts_select_authed policy', /CREATE\s+POLICY\s+shifts_select_authed[\s\S]*?ON\s+public\.radscheduler_shifts[\s\S]*?FOR\s+SELECT[\s\S]*?TO\s+authenticated/i],
  ['audit_insert_scoped policy', /CREATE\s+POLICY\s+audit_insert_scoped[\s\S]*?ON\s+public\.radscheduler_audit[\s\S]*?FOR\s+INSERT[\s\S]*?TO\s+authenticated/i],
  ['audit_select_scoped policy', /CREATE\s+POLICY\s+audit_select_scoped[\s\S]*?ON\s+public\.radscheduler_audit[\s\S]*?FOR\s+SELECT[\s\S]*?TO\s+authenticated/i],
  ['telemetry_insert_scoped policy', /CREATE\s+POLICY\s+telemetry_insert_scoped[\s\S]*?ON\s+public\.radscheduler_telemetry[\s\S]*?FOR\s+INSERT[\s\S]*?TO\s+authenticated/i],
  ['telemetry_select_scoped policy', /CREATE\s+POLICY\s+telemetry_select_scoped[\s\S]*?ON\s+public\.radscheduler_telemetry[\s\S]*?FOR\s+SELECT[\s\S]*?TO\s+authenticated/i],
];

for (const [label, pattern] of policyChecks) {
  requireMatch(label.startsWith('telemetry_') ? allScope : hardeningScope, label, pattern);
}

const objectChecks = [
  ['audit dedupe unique index', /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+radscheduler_audit_dedupe_idx/i],
  ['shift touch function with fixed search_path', /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\._radscheduler_shifts_touch\(\)[\s\S]*?SET\s+search_path\s*=\s*public,\s*pg_temp/i],
  ['rls_auto_enable public execute revoked', /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.rls_auto_enable\(\)\s+FROM\s+authenticated/i],
  ['radscheduler_shifts touch trigger', /CREATE\s+TRIGGER\s+radscheduler_shifts_touch_trg/i],
  ['audit table RLS enabled', /ALTER\s+TABLE\s+public\.radscheduler_audit\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i],
  ['shift table RLS enabled', /ALTER\s+TABLE\s+public\.radscheduler_shifts\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i],
  ['telemetry table RLS enabled', /ALTER\s+TABLE\s+public\.radscheduler_telemetry\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i],
  ['telemetry practice index', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+radscheduler_telemetry_practice_created_idx/i],
];

for (const [label, pattern] of objectChecks) {
  requireMatch(allScope, label, pattern);
}

rejectMatch(hardeningScope, 'broad FOR ALL authenticated policy still present in hardening migration', /CREATE\s+POLICY[\s\S]*?\bFOR\s+ALL\s+TO\s+authenticated/i);
rejectMatch(hardeningScope, 'broad TRUE RLS predicate in hardening migration', /\b(USING|WITH\s+CHECK)\s*\(\s*TRUE\s*\)/i);

for (const match of hardeningSqlOnly.matchAll(/auth\.jwt\(\)/gi)) {
  const before = hardeningSqlOnly.slice(Math.max(0, match.index - 24), match.index);
  if (!/select\s*$/i.test(before)) {
    failures.push('docs/sql/04-rls-advisor-hardening.sql: unoptimized auth.jwt() call in hardening migration');
    break;
  }
}

if (failures.length) {
  console.error('Migration drift check failed:');
  console.error(failures.map(f => `- ${f}`).join('\n'));
  process.exit(1);
}

console.log('Migration drift check passed');
