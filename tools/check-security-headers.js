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

const index = read('index.html');
const headers = read('_headers');
const vercel = JSON.parse(read('vercel.json'));

const metaCsp = index.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([\s\S]*?)">/i)?.[1] || '';
requireMatch('index.html CSP', metaCsp, /default-src\s+'self'/);
requireMatch('index.html CSP', metaCsp, /script-src[\s\S]*'unsafe-inline'[\s\S]*https:\/\/cdn\.jsdelivr\.net[\s\S]*https:\/\/cdnjs\.cloudflare\.com/);
requireMatch('index.html CSP', metaCsp, /connect-src[\s\S]*https:\/\/\*\.supabase\.co[\s\S]*wss:\/\/\*\.supabase\.co[\s\S]*https:\/\/api\.github\.com/);
requireMatch('index.html CSP', metaCsp, /object-src\s+'none'/);
requireMatch('index.html CSP', metaCsp, /base-uri\s+'self'/);
requireMatch('index.html CSP', metaCsp, /form-action\s+'none'/);

requireMatch('_headers', headers, /Content-Security-Policy:/);
requireMatch('_headers', headers, /X-Frame-Options:\s*DENY/);
requireMatch('_headers', headers, /X-Content-Type-Options:\s*nosniff/);
requireMatch('_headers', headers, /Permissions-Policy:\s*geolocation=\(\), microphone=\(\), camera=\(\), payment=\(\)/);

const allVercelHeaders = JSON.stringify(vercel.headers || []);
requireMatch('vercel.json', allVercelHeaders, /Content-Security-Policy/);
requireMatch('vercel.json', allVercelHeaders, /X-Frame-Options/);
requireMatch('vercel.json', allVercelHeaders, /X-Content-Type-Options/);
requireMatch('vercel.json', allVercelHeaders, /Permissions-Policy/);

if (failures.length) {
  console.error('Security header check failed:');
  console.error(failures.map(f => `- ${f}`).join('\n'));
  process.exit(1);
}

console.log('Security header check passed');
