#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const required = [
  ['CodeQL workflow', '.github/workflows/codeql.yml', /github\/codeql-action\/(init|analyze)@v\d+/],
  ['Staging CI workflow', '.github/workflows/staging-ci.yml', /npm run test:e2e/],
  ['Dependabot config', '.github/dependabot.yml', /package-ecosystem:\s*npm/],
  ['Enterprise readiness docs', 'docs/ENTERPRISE-READINESS.md', /OWASP ASVS[\s\S]*NIST CSF 2\.0/],
  ['Environment docs', 'docs/ENVIRONMENTS.md', /staging[\s\S]*production/i],
  ['Telemetry migration', 'docs/sql/06-enterprise-telemetry.sql', /CREATE TABLE IF NOT EXISTS public\.radscheduler_telemetry/],
  ['Admin MFA migration', 'docs/sql/05-admin-mfa-aal2-hardening.sql', /radscheduler_admin_aal2/],
];

const failures = [];
for (const [label, rel, pattern] of required) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    failures.push(`${label}: missing ${rel}`);
    continue;
  }
  const text = fs.readFileSync(full, 'utf8');
  if (!pattern.test(text)) failures.push(`${label}: ${rel} does not contain expected evidence`);
}

if (failures.length) {
  console.error('Enterprise readiness check failed:');
  console.error(failures.map(f => `- ${f}`).join('\n'));
  process.exit(1);
}

console.log('Enterprise readiness check passed');
