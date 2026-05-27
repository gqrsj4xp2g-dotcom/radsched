#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targets = [
  'index.html',
  ...fs.readdirSync(path.join(root, 'docs/sql'))
    .filter(name => name.endsWith('.sql'))
    .map(name => `docs/sql/${name}`),
];

const issues = [];

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('--') || t.startsWith('//') || t.startsWith('*');
}

function report(file, lineNo, message, line) {
  issues.push(`${file}:${lineNo}: ${message}\n  ${line.trim()}`);
}

for (const file of targets) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (isCommentLine(line)) return;
    const lineNo = idx + 1;
    if (/CREATE\s+POLICY\s+["']?public_all\b/i.test(line)) {
      report(file, lineNo, 'Do not document or ship public_all RLS policies.', line);
    }
    if (/\bUSING\s*\(\s*TRUE\s*\)|\bWITH\s+CHECK\s*\(\s*TRUE\s*\)/i.test(line)) {
      report(file, lineNo, 'Broad TRUE RLS policy detected; scope by practice/role.', line);
    }
    if (/\bFOR\s+ALL\s+TO\s+authenticated\b/i.test(line)) {
      report(file, lineNo, 'Split FOR ALL policies into action-specific SELECT/INSERT/UPDATE/DELETE policies.', line);
    }
    if (line.includes('auth.jwt()') && !line.includes('(select auth.jwt())')) {
      report(file, lineNo, 'Use (select auth.jwt()) in RLS policies to avoid per-row init-plan overhead.', line);
    }
  });
}

if (issues.length) {
  console.error('SQL/RLS lint failed:');
  console.error(issues.join('\n'));
  process.exit(1);
}

console.log('SQL/RLS lint passed');
