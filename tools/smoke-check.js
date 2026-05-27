#!/usr/bin/env node
// smoke-check.js -- fast structural checks for the deployable app shell.
//
// This deliberately avoids browser or npm dependencies so it can run in
// GitHub Actions, pre-commit hooks, and ad-hoc local audits. It catches
// regressions that parsecheck cannot see: stale service-worker versions,
// missing PWA assets, stale embedded setup snippets, and role-gate drift.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const failures = [];

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function nonEmpty(file) {
  const p = path.join(ROOT, file);
  return fs.existsSync(p) && fs.statSync(p).size > 0;
}

function check(name, ok, detail = '') {
  if (!ok) failures.push({ name, detail });
}

function matchOne(text, re, name) {
  const m = text.match(re);
  check(name, !!m, `Missing pattern: ${re}`);
  return m ? m[1] : null;
}

function extractObjectLiteral(text, constName) {
  const startRe = new RegExp(`const\\s+${constName}\\s*=\\s*\\{`);
  const start = text.search(startRe);
  if (start < 0) return null;
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

function extractArrayLiteral(text, constName) {
  const startRe = new RegExp(`const\\s+${constName}\\s*=\\s*\\[`);
  const start = text.search(startRe);
  if (start < 0) return null;
  const open = text.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

function extractFunctionWindow(text, name, maxChars = 4500) {
  const idx = text.indexOf(`function ${name}(`);
  if (idx < 0) return '';
  return text.slice(idx, idx + maxChars);
}

function unique(arr) {
  return [...new Set(arr)];
}

const index = read('index.html');
const sw = read('sw.js');
const manifestRaw = read('manifest.webmanifest');
const cssAuth = read('src/parts/css-auth.css');
const cssMobile = read('src/parts/css-mobile.css');
const cssTokens = read('src/parts/css-tokens.css');
let manifest = null;
try {
  manifest = JSON.parse(manifestRaw);
} catch (e) {
  failures.push({ name: 'manifest.webmanifest parses as JSON', detail: e.message });
}

// Build/version coherence.
const htmlBuild = matchOne(index, /const\s+_RS_HTML_BUILD\s*=\s*['"]([^'"]+)['"]/, 'index.html exposes _RS_HTML_BUILD');
const htmlSw = matchOne(index, /const\s+_SW_VERSION\s*=\s*['"]([^'"]+)['"]/, 'index.html exposes _SW_VERSION');
const swVersion = matchOne(sw, /const\s+CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/, 'sw.js exposes CACHE_VERSION');
if (htmlBuild && htmlSw && swVersion) {
  check('HTML build, HTML SW, and sw.js versions match', htmlBuild === htmlSw && htmlSw === swVersion, `${htmlBuild} / ${htmlSw} / ${swVersion}`);
}

// Local/prod shell hygiene.
check('No Cloudflare email-decoder shim in app shell', !/(cdn-cgi|email-decode|cloudflare-static)/.test(index), 'Remove injected CDN scripts from index.html.');
check('No stale create-user adminCount snippet remains', !/\badminCount\b/.test(index) && !/\badminCount\b/.test(read('supabase/functions/create-user/index.ts')), 'Use privilegedCount/admin+superuser bootstrap logic.');
check('Managed CSS sources do not start with marker text', !/^\s*Edit the source file/m.test([cssAuth, cssMobile, cssTokens].join('\n---\n')), 'Marker text outside comments can invalidate following CSS.');
check('Token source comment avoids nested CSS comment delimiters', !/between\s+\/\*/.test(cssTokens), 'Nested /* */ inside comments can corrupt CSS parsing.');
check('Mobile drawer CSS is present in built shell', /@media\(max-width:760px\)[\s\S]{0,800}\.sidebar\s*\{[\s\S]{0,320}position:fixed/.test(index), 'Mobile sidebar must be off-canvas on phones.');

// PWA assets referenced by sw.js and manifest exist.
const shellLiteral = extractArrayLiteral(sw, 'SHELL');
check('sw.js SHELL array is discoverable', !!shellLiteral);
if (shellLiteral) {
  const shellAssets = unique([...shellLiteral.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]));
  for (const asset of shellAssets) {
    if (asset === '/') continue;
    const file = asset.replace(/^\//, '');
    check(`Service-worker shell asset exists: ${asset}`, nonEmpty(file), rel(path.join(ROOT, file)));
  }
  check('sw.js never pre-caches itself', !shellAssets.includes('/sw.js') && !shellAssets.includes('sw.js'), 'sw.js must be network-fresh for update detection.');
}

if (manifest) {
  check('Manifest has name and short_name', !!manifest.name && !!manifest.short_name);
  check('Manifest start_url stays in scope', typeof manifest.start_url === 'string' && manifest.start_url.startsWith('/'));
  check('Manifest scope is root', manifest.scope === '/');
  check('Manifest declares icons', Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  for (const icon of manifest.icons || []) {
    const file = String(icon.src || '').replace(/^\//, '');
    check(`Manifest icon exists: ${icon.src}`, nonEmpty(file), file);
  }
  for (const shortcut of manifest.shortcuts || []) {
    const url = String(shortcut.url || '');
    const page = new URL(url, 'https://local.test').searchParams.get('p');
    if (page) {
      check(`Manifest shortcut target exists: ${page}`, index.includes(`id="page-${page}"`), shortcut.url);
    }
  }
}

// Edge setup panels must load current repo sources, not stale embedded code.
const edgePathsLiteral = extractObjectLiteral(index, '_EDGE_FN_SOURCE_PATHS');
check('Edge function source path map exists', !!edgePathsLiteral);
if (edgePathsLiteral) {
  const entries = [...edgePathsLiteral.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)];
  check('Edge function source path map is non-empty', entries.length > 0);
  for (const [, name, srcPath] of entries) {
    check(`Edge source exists for ${name}`, nonEmpty(srcPath), srcPath);
  }
  check('Embedded edge source fallbacks are blanked at runtime', /_EDGE_FN_SOURCES\[name\]\s*=\s*''/.test(index));
}

// Privileged role gates. These are intentionally specific because the app has
// both "admin" and "superuser" as privileged roles; exact-role drift is easy.
const srcDash = read('src/parts/js-render-dash.js');
const createUser = read('supabase/functions/create-user/index.ts');
const adminOps = read('supabase/functions/admin-ops/index.ts');
check('Dashboard source uses admin-or-superuser gate', /_isAdminOrSU\(\)/.test(srcDash), 'src/parts/js-render-dash.js');
check('Dashboard source does not use admin-only isAdm', !/const\s+isAdm\s*=\s*CU\.role\s*={2,3}\s*['"]admin['"]/.test(srcDash));
check('Practice switcher uses admin-or-superuser gate', /renderPracticesPage[\s\S]{0,1800}_isAdminOrSU\(\)/.test(index));
check('Practice list escapes practice names', /<td><code>\$\{escHtml\(p\.id\)\}<\/code><\/td>/.test(index) && /\$\{escHtml\(p\.name\)\}/.test(index));

const widgetFn = extractFunctionWindow(index, 'renderWidgetPage', 900);
check('Widget page allows superusers', /_isAdminOrSU\(\)/.test(widgetFn), 'renderWidgetPage should not check CU.role === admin only.');

const broadcastFn = extractFunctionWindow(index, '_broadcastAudience', 1800);
check('Broadcast admin audience includes superusers', /role\s*={2,3}\s*['"]admin['"][\s\S]{0,80}role\s*={2,3}\s*['"]superuser['"]/.test(broadcastFn));
check('Broadcast physician audience excludes admin-only and superuser-only accounts', /u\.role\s*!={2,3}\s*['"]admin['"][\s\S]{0,80}u\.role\s*!={2,3}\s*['"]superuser['"]/.test(broadcastFn));

const reportFn = extractFunctionWindow(index, 'sendMonthlyReportCard', 2200);
check('Monthly report recipients include superusers', /role\s*={2,3}\s*['"]admin['"][\s\S]{0,100}role\s*={2,3}\s*['"]superuser['"]/.test(reportFn));
check('User management has protected superuser edit guard', /function\s+_canEditUserRecord\(u\)/.test(index) && /_isSU\(\)/.test(extractFunctionWindow(index, '_canEditUserRecord', 300)));
check('System health card exists in ops tools', /id="sys-health-result"/.test(index) && /function\s+renderSystemHealth\(/.test(index));
check('Rollback timeline is visible in tools', /showUndoTimeline\(\)/.test(index) && /Rollback timeline/.test(index));
check('SSO login entry point exists', /function\s+doSSOLogin\(/.test(index) && /signInWithSSO/.test(index) && /auth-sso-domain/.test(index));

check('create-user normalizes auth roles', /function\s+normalizeAuthRole/.test(createUser));
check('create-user bootstrap counts privileged roles', /privilegedCount/.test(createUser) && /role\s*===\s*["']superuser["']/.test(createUser));
check('create-user requires admin MFA/AAL2', /function\s+hasAal2/.test(createUser) && /mfa_required/.test(createUser));
check('create-user has per-caller rate limit', /function\s+rateLimit/.test(createUser) && /Too many user-management requests/.test(createUser));
check('create-user protects superuser mutation paths', [
  /Only a superuser can modify another superuser account/,
  /Only a superuser can grant the superuser role/,
  /Only a superuser can create another superuser account/,
  /Only a superuser can delete another superuser account/,
].every(re => re.test(createUser)));
check('admin-ops restores through service-role wrapper with audit evidence', [
  /restore-backup/.test(adminOps),
  /function\s+hasAal2/.test(adminOps),
  /function\s+rateLimit/.test(adminOps),
  /radscheduler_backups/.test(adminOps),
  /radscheduler_audit/.test(adminOps),
  /radscheduler_telemetry/.test(adminOps),
].every(Boolean));
check('Edge monitor probes admin-ops', /probe admin-ops POST/.test(read('tools/check-edge-functions.sh')));

// Navigation sanity: every sidebar data-pg should have a matching page, except
// superuser pseudo-pages that render through shared superuser code.
const sidebarPages = unique([...index.matchAll(/data-pg="([^"]+)"/g)]
  .map(m => m[1])
  .filter(page => /^[a-z0-9-]+$/.test(page)));
const dynamicPages = new Set(['su-dashboard', 'su-practices', 'su-users']);
for (const page of sidebarPages) {
  if (dynamicPages.has(page)) continue;
  check(`Sidebar page exists: ${page}`, index.includes(`id="page-${page}"`), `Missing #page-${page}`);
}

if (failures.length) {
  console.error('Smoke check failed:');
  for (const f of failures) {
    console.error(`- ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  }
  process.exit(1);
}

console.log(`Smoke check passed (${[
  'versions',
  'PWA assets',
  'edge source paths',
  'privileged gates',
  'navigation targets',
].join(', ')}).`);
