'use strict';

const fs = require('node:fs');

function checkPublicShell(html) {
  const island = /^<script id="rs-private-export" type="application\/json">([\s\S]*?)<\/script>/m.exec(html);
  if (!island || island[1].trim()) throw new Error('Publishing requires a clean shell with an empty private snapshot.');
  const users = /^let USERS\s*=\s*\/\*USERS_START\*\/([\s\S]*?)\/\*USERS_END\*\//m.exec(html);
  if (!users || users[1].trim() !== '[]') throw new Error('The public shell must have an empty user directory.');
  const seed = /^let S=\/\*S_START\*\/([\s\S]*?)\/\*S_END\*\//m.exec(html);
  if (!seed) throw new Error('Cannot verify the public scheduling defaults.');
  const core = ['physicians', 'drShifts', 'irShifts', 'weekendCalls', 'irCalls', 'vacations', 'holidays', 'openShifts', 'chatMessages'];
  for (const key of core) {
    if (key === 'chatMessages' && !/\bchatMessages\s*:/.test(seed[1])) continue;
    if (!new RegExp('\\b' + key + '\\s*:\\s*\\[\\s*\\]').test(seed[1])) throw new Error('The public shell contains nonempty or unrecognized practice defaults.');
  }
  // Older exporters could place the snapshot inside their own function and
  // leave startup defaults empty. Reject those signatures anywhere in a page.
  if (/\/\*S_START\*\/\s*\{\s*"/.test(html) || /\/\*USERS_START\*\/\s*\[\s*\{/.test(html)) {
    throw new Error('A legacy private snapshot was found in the release artifact.');
  }
}

module.exports = { checkPublicShell };
if (require.main === module) {
  try {
    checkPublicShell(fs.readFileSync(process.argv[2] || 'index.html', 'utf8'));
    console.log('Public shell is free of embedded practice snapshots.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
