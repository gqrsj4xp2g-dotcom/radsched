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

for (const rel of ['.env.example', '.env.staging.example']) {
  if (!fs.existsSync(path.join(root, rel))) failures.push(`${rel}: missing environment template`);
}

const envDoc = read('docs/ENVIRONMENTS.md');
requireMatch('docs/ENVIRONMENTS.md', envDoc, /staging[\s\S]*production/i);
requireMatch('docs/ENVIRONMENTS.md', envDoc, /different Supabase project URLs/i);
requireMatch('docs/ENVIRONMENTS.md', envDoc, /maintenance window/i);

const deploy = read('.github/workflows/deploy.yml');
requireMatch('deploy.yml', deploy, /branches:\s*\[main\]/);
if (/branches:\s*\[[^\]]*staging[^\]]*\]/.test(deploy)) {
  failures.push('deploy.yml: production deploy workflow must not deploy from staging');
}

const staging = read('.github/workflows/staging-ci.yml');
requireMatch('staging-ci.yml', staging, /branches:\s*\[staging\]/);
requireMatch('staging-ci.yml', staging, /pull_request:[\s\S]*branches:\s*\[main\]/);
requireMatch('staging-ci.yml', staging, /npm run test:environment/);

const ops = read('.github/workflows/ops-monitor.yml');
requireMatch('ops-monitor.yml', ops, /RS_SUPABASE_URL/);

if (process.env.RS_SUPABASE_URL && process.env.RS_STAGING_SUPABASE_URL &&
    process.env.RS_SUPABASE_URL === process.env.RS_STAGING_SUPABASE_URL) {
  failures.push('RS_SUPABASE_URL and RS_STAGING_SUPABASE_URL must point to different projects');
}

if (failures.length) {
  console.error('Environment config check failed:');
  console.error(failures.map(f => `- ${f}`).join('\n'));
  process.exit(1);
}

console.log('Environment config check passed');
