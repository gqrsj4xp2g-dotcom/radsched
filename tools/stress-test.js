#!/usr/bin/env node
// stress-test.js — synthesize a 200-physician practice + 1 year of
// shifts and report the serialized payload size + per-array sizes.
//
// Mirrors what the in-app stress test does (Tools → Robustness →
// "🧪 Stress test (200 phys)") but runs offline so you can baseline
// scaling characteristics without spinning up the live app.
//
// Usage:
//   node tools/stress-test.js
//   node tools/stress-test.js --phys 100 --days 90

const N_PHYS_DEFAULT = 200;
const N_DAYS_DEFAULT = 365;

const args = process.argv.slice(2);
function arg(name, def){
  const i = args.indexOf('--' + name);
  if(i < 0) return def;
  const v = +args[i + 1];
  return Number.isFinite(v) ? v : def;
}
const N_PHYS = arg('phys', N_PHYS_DEFAULT);
const N_DAYS = arg('days', N_DAYS_DEFAULT);

console.log(`▶ Synthesizing ${N_PHYS} physicians × ${N_DAYS} days of shifts…`);
const t0 = Date.now();

// ── Synthesize ─────────────────────────────────────────────────────
const subs  = ['Neuro','Body MRI','Chest','MSK','Breast','Pediatric','Nuclear','General','Mammo','IR'];
const sites = ['Main','East','West','North'];
const lastNames = ['Smith','Patel','Lee','Chen','Garcia','Brown','Davis','Wilson','Park','Anderson','Taylor','Thomas','Hernandez','Moore','Martin','Jackson','Thompson','White','Lopez','Martinez','Robinson','Clark','Rodriguez','Lewis','Young','Walker','Hall','Allen','King','Wright'];
const firstNames = ['Alex','Maria','James','Sara','Michael','Anna','David','Lisa','John','Emily','Robert','Jessica','Daniel','Patricia'];

const fmtDate = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
};

const physicians = [];
for(let i = 0; i < N_PHYS; i++){
  const last = lastNames[i % lastNames.length] + (i >= lastNames.length ? '-' + Math.floor(i/lastNames.length) : '');
  const first = firstNames[i % firstNames.length];
  const role = (i % 5 === 0) ? 'IR' : (i % 7 === 0 ? 'MIXED' : 'DR');
  physicians.push({
    id: 1000 + i, first, last, role,
    drFte: role === 'IR' ? 0 : (0.5 + (i % 6) * 0.1),
    irFte: role === 'DR' ? 0 : (0.5 + (i % 4) * 0.125),
    drSubs: subs.slice(i % subs.length, (i % subs.length) + 2),
    irSubs: role === 'DR' ? [] : ['IR'],
    anchorSite: sites[i % sites.length],
    allowedSites: sites,
    siteRules: [], irCallBlackouts: [], dayConditions: [], tbRules: [],
    callDayRules: [], siteSeqRules: [],
    debulkingEligible: true, wRVUMultiplier: 1.0,
  });
}

const drShifts = [], weekendCalls = [], irCalls = [];
const today = new Date();
let nextId = 100000;
for(let d = 0; d < N_DAYS; d++){
  const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 180 + d);
  const ds = fmtDate(dt);
  const dow = dt.getDay();
  if(dow === 6){
    weekendCalls.push({
      id: nextId++,
      physId: physicians[(d * 13) % N_PHYS].id,
      satDate: ds,
      sunDate: fmtDate(new Date(dt.getTime() + 86400000)),
      site: sites[0],
      notes: 'Synth',
    });
  } else if(dow !== 0){
    sites.forEach((site, sIdx) => {
      for(let i = 0; i < 5; i++){
        drShifts.push({
          id: nextId++,
          physId: physicians[((d * 11) + (sIdx * 7) + i * 3) % N_PHYS].id,
          date: ds, shift: '1st', site,
          sub: subs[i % subs.length], notes: 'Synth', autoHome: false,
        });
      }
      if(sIdx === 0){
        irCalls.push({
          id: nextId++,
          physId: physicians[((d * 17)) % N_PHYS].id,
          date: ds, callType: 'daily', irGroup: 'North', notes: 'Synth',
        });
      }
    });
  }
}

const tSynth = Date.now() - t0;

// ── Profile the serialized payload ─────────────────────────────────
const payload = { physicians, drShifts, weekendCalls, irCalls, vacations: [], holidays: [], cfg: {} };

const t1 = Date.now();
const json = JSON.stringify(payload);
const tJson = Date.now() - t1;

const t2 = Date.now();
JSON.parse(json);
const tParse = Date.now() - t2;

const sizes = {
  physicians: JSON.stringify(payload.physicians).length,
  drShifts:   JSON.stringify(payload.drShifts).length,
  weekendCalls: JSON.stringify(payload.weekendCalls).length,
  irCalls:    JSON.stringify(payload.irCalls).length,
  total:      json.length,
};

const fmtKB = (b) => (b / 1024).toFixed(1) + ' KB';
const fmtMB = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';

// ── Report ─────────────────────────────────────────────────────────
console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log(`Stress test results — ${N_PHYS} physicians × ${N_DAYS} days`);
console.log('═══════════════════════════════════════════════════════════');
console.log('');
console.log(`Synthesis time:       ${tSynth} ms`);
console.log(`JSON.stringify time:  ${tJson} ms`);
console.log(`JSON.parse time:      ${tParse} ms`);
console.log('');
console.log('Per-array payload size (uncompressed):');
console.log(`  physicians   ${physicians.length.toString().padStart(6)} rows  ${fmtKB(sizes.physicians).padStart(10)}`);
console.log(`  drShifts     ${drShifts.length.toString().padStart(6)} rows  ${fmtKB(sizes.drShifts).padStart(10)}`);
console.log(`  weekendCalls ${weekendCalls.length.toString().padStart(6)} rows  ${fmtKB(sizes.weekendCalls).padStart(10)}`);
console.log(`  irCalls      ${irCalls.length.toString().padStart(6)} rows  ${fmtKB(sizes.irCalls).padStart(10)}`);
console.log(`  ─────────────────────────────────────`);
console.log(`  Total                       ${fmtKB(sizes.total).padStart(10)}  (${fmtMB(sizes.total)})`);
console.log('');

// ── Verdict ────────────────────────────────────────────────────────
const sizeMB = sizes.total / 1024 / 1024;
let verdict;
if(sizeMB < 1) verdict = '✓ FINE — well under the 1 MB JSON-blob comfort zone';
else if(sizeMB < 2) verdict = '◐ APPROACHING LIMITS — gzip the upload (see docs/SCALING.md item 1)';
else if(sizeMB < 5) verdict = '⚠ NEEDS MIGRATION — start splitting auditLog out (see docs/SCALING.md item 3)';
else verdict = '🚨 OVER LIMITS — split shift arrays into per-table rows (item 6)';
console.log('Verdict: ' + verdict);
console.log('');
console.log('Compare to your live practice payload by running:');
console.log('  SELECT octet_length(data::text) FROM public.radscheduler;');
console.log('in the Supabase SQL editor.');
console.log('');
