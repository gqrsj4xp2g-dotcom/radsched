const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
const names = ['_rsPracticeId', '_rsReadScope', '_rsTeardown', '_rsReportsPull',
  '_prPull', '_prLoadScorecard', '_prLoadAdminSummary', '_prGradePending'];
const functions = names.map(name => {
  const match = html.match(new RegExp('^(?:async )?function '+name+'\\([^\\n]*\\)\\{[\\s\\S]*?^\\}', 'm'));
  assert.ok(match, name);
  return match[0];
}).join('\n');

function client() {
  const pending = new Map();
  function deferred(key) {
    return new Promise(resolve => pending.set(key, resolve));
  }
  const queried = [];
  const backend = {
    from(table) {
      return {
        select() { return this; },
        eq(column, practice) { queried.push([table, practice]); return this; },
        order() { return this; },
        limit() { return deferred(table); }
      };
    },
    rpc(name, {p_practice}) { queried.push([name, p_practice]); return deferred(name); }
  };
  const context = vm.createContext({
    CU: { id: 'user', role: 'superuser', practiceId: 'home' }, _ROW_ID: 'active',
    _rsReadGeneration: 0, _rsReportsChannel: null, _rsPollTimer: null, _rsRtDebounce: null, _wrvuSummaryGen: 0,
    _RS_REPORTS: [], _RS_REPORTS_STATE: 'ready', _RS_REPORTS_AT: 0, _PR_REVIEWS: [], _PR_AT: 0,
    _prPriors: new Map(), _prScorecard: new Map(), _prScorecardLoading: new Set(),
    _prAdminSummary: new Map(), _prAdminSummaryLoading: new Set(),
    document: { getElementById() { return null; } }, _prUpdateNavBadge() {}, _prCloseGrader() {},
    _prShowGrader() { throw Error('A prior session opened the grader'); },
    _rsFetchReportText() { return deferred('report_text'); }, _rsScoreUnscored() {}, _initAuthClient: () => backend
  });
  vm.runInContext(functions, context);
  return { context, pending, queried };
}

test('reports, peer rows and quarterly reads follow the active practice and accept its responses', async () => {
  const { context: c, pending, queried } = client();
  const reads = [c._rsReportsPull(true), c._prPull(true), c._prLoadScorecard('Q'), c._prLoadAdminSummary('Q')];
  assert.equal(queried.length, 4);
  assert.ok(queried.every(([, practice]) => practice === 'active'));
  pending.get('rs_reports')({ data: [{ report_uid: 'report' }] });
  pending.get('rs_peer_reviews')({ data: [{ id: 10 }] });
  pending.get('rs_peer_my_scorecard')({ data: { n: 1 } });
  pending.get('rs_peer_review_summary')({ data: [{ n: 2 }] });
  await Promise.all(reads);
  assert.equal(c._RS_REPORTS[0].report_uid, 'report');
  assert.equal(c._PR_REVIEWS[0].id, 10);
  assert.equal(c._prScorecard.get('Q').n, 1);
  assert.equal(c._prAdminSummary.get('Q')[0].n, 2);
});

for (const transition of ['practice changes', 'account changes', 'same account signs in again']) {
  test('late responses are discarded when '+transition, async () => {
    const { context: c, pending } = client();
    c._PR_REVIEWS = [{ id: 7, report_uid: 'synthetic-report' }];
    const reads = [c._rsReportsPull(true), c._prPull(true), c._prLoadScorecard('Q'),
      c._prLoadAdminSummary('Q'), c._prGradePending(7)];
    c._rsTeardown();
    if (transition === 'practice changes') c._ROW_ID = 'new-practice';
    if (transition === 'account changes') c.CU = { ...c.CU, id: 'new-user' };
    pending.get('rs_reports')({ data: [{ report_uid: 'old' }] });
    pending.get('rs_peer_reviews')({ data: [{ id: 1 }] });
    pending.get('rs_peer_my_scorecard')({ data: { n: 1 } });
    pending.get('rs_peer_review_summary')({ data: [{ n: 1 }] });
    pending.get('report_text')('Synthetic prior report');
    await Promise.all(reads);
    assert.equal(c._RS_REPORTS.length, 0);
    assert.equal(c._PR_REVIEWS.length, 0);
    assert.equal(c._prScorecard.size, 0);
    assert.equal(c._prAdminSummary.size, 0);
  });
}

test('a scope change while a quarterly read is pending also drops the result before teardown', async () => {
  const { context: c, pending } = client();
  const read = c._prLoadScorecard('Q');
  c._ROW_ID = 'other';
  pending.get('rs_peer_my_scorecard')({ data: { n: 1 } });
  assert.equal(await read, null);
  assert.equal(c._prScorecard.size, 0);
});
