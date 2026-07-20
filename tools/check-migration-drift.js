#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sqlDir = path.join(root, 'docs/sql');
const migrationDir = path.join(root, 'supabase/migrations');
const hardeningPath = path.join(sqlDir, '04-rls-advisor-hardening.sql');
const hardening = fs.readFileSync(hardeningPath, 'utf8');
const allSql = fs.readdirSync(sqlDir)
  .filter(name => name.endsWith('.sql'))
  .sort()
  .map(name => fs.readFileSync(path.join(sqlDir, name), 'utf8'))
  .join('\n\n');

const failures = [];

const migrationFiles = fs.existsSync(migrationDir)
  ? fs.readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort()
  : [];
if (migrationFiles.length < 58) {
  failures.push(`supabase/migrations: expected fetched remote history plus local hardening migrations (found ${migrationFiles.length}, need >= 58)`);
}
const ingestHashMigrationName = migrationFiles.find(name => name.includes('rs_hash_ingest_credentials'));
if (!ingestHashMigrationName) {
  failures.push('supabase/migrations: missing hashed ingest-credential migration');
} else {
  const ingestHashMigration = fs.readFileSync(path.join(migrationDir, ingestHashMigrationName), 'utf8');
  const requiredIngestHardening = [
    ['one-way token digest', /extensions\.digest\(token,\s*'sha256'\)/i],
    ['plaintext token removal', /update\s+public\.rs_ingest_tokens\s+set\s+token\s*=\s*null/i],
    ['unique token hash index', /unique\s+index[\s\S]*rs_ingest_tokens_token_hash/i],
    ['one-time rotation token', /return\s+v_token/i],
  ];
  for (const [label, pattern] of requiredIngestHardening) {
    if (!pattern.test(ingestHashMigration)) failures.push(`${ingestHashMigrationName}: missing ${label}`);
  }
}
const serviceDenyMigrationName = migrationFiles.find(name => name.includes('rs_service_table_deny_policies'));
if (!serviceDenyMigrationName) {
  failures.push('supabase/migrations: missing explicit client-deny policies for server-only tables');
} else {
  const serviceDenyMigration = fs.readFileSync(path.join(migrationDir, serviceDenyMigrationName), 'utf8');
  for (const table of ['rs_ingest_tokens', 'rs_widget_secrets']) {
    const policyPattern = new RegExp(`create\\s+policy\\s+${table}_deny_clients[\\s\\S]*?on\\s+public\\.${table}[\\s\\S]*?using\\s*\\(false\\)[\\s\\S]*?with\\s+check\\s*\\(false\\)`, 'i');
    if (!policyPattern.test(serviceDenyMigration)) failures.push(`${serviceDenyMigrationName}: missing explicit deny policy for ${table}`);
  }
}
const versions = migrationFiles.map(name => name.split('_')[0]);
if (new Set(versions).size !== versions.length) failures.push('supabase/migrations: duplicate migration version');
const securityMigrationName = migrationFiles.find(name => name.includes('rs_security_atomic_tenant_widget_hardening'));
if (!securityMigrationName) {
  failures.push('supabase/migrations: missing atomic tenant/widget security migration');
} else {
  const securityMigration = fs.readFileSync(path.join(migrationDir, securityMigrationName), 'utf8');
  const requiredSecurityObjects = [
    ['atomic practice save RPC', /create\s+or\s+replace\s+function\s+public\.rs_save_practice_cas/i],
    ['widget secret private table', /create\s+table\s+if\s+not\s+exists\s+public\.rs_widget_secrets/i],
    ['superuser-only global helper', /app_metadata[\s\S]{0,120}role'\)\s*=\s*'superuser'/i],
    ['same-practice admin MFA', /radscheduler_admin_same_practice[\s\S]{0,700}->>\s*'aal'\)\s*=\s*'aal2'/i],
    ['CAS public revoke', /revoke\s+all\s+on\s+function\s+public\.rs_save_practice_cas[\s\S]*?from\s+public,\s*anon/i],
  ];
  for (const [label, pattern] of requiredSecurityObjects) {
    if (!pattern.test(securityMigration)) failures.push(`${securityMigrationName}: missing ${label}`);
  }
}

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
  ['admin AAL2 RLS helper', /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.radscheduler_admin_aal2\(\)[\s\S]*?coalesce\(\(select auth\.jwt\(\)\)\s*->>\s*'aal'/i],
  ['same-practice access helper permits same-practice admins at aal1', /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.radscheduler_non_admin_same_practice\(target_practice_id\s+text\)[\s\S]*?SELECT\s+target_practice_id\s*=\s*\(\(select\s+auth\.jwt\(\)\)\s*->\s*'app_metadata'\s*->>\s*'practiceId'\)/i],
  ['radscheduler_shifts touch trigger', /CREATE\s+TRIGGER\s+radscheduler_shifts_touch_trg/i],
  ['audit table RLS enabled', /ALTER\s+TABLE\s+public\.radscheduler_audit\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i],
  ['shift table RLS enabled', /ALTER\s+TABLE\s+public\.radscheduler_shifts\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i],
  ['telemetry table RLS enabled', /ALTER\s+TABLE\s+public\.radscheduler_telemetry\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i],
  ['telemetry practice index', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+radscheduler_telemetry_practice_created_idx/i],
  ['audit immutable entry hash column', /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+entry_hash\s+text/i],
  ['audit hash trigger', /CREATE\s+TRIGGER\s+radscheduler_audit_hash_before_insert_trg/i],
  ['audit append-only mutation trigger', /CREATE\s+TRIGGER\s+radscheduler_audit_prevent_update_trg/i],
  ['audit update delete revoked', /REVOKE\s+UPDATE,\s+DELETE\s+ON\s+public\.radscheduler_audit\s+FROM\s+authenticated/i],
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
