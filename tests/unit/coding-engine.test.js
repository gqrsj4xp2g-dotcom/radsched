const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi), m => m[1]);
const engine = scripts.find(script => script.includes("window.codingScore = function"));
assert.ok(engine, "the shipped browser scorer is present");

function loadScorer(posture = "professional") {
  const elements = { "coding-posture": { value: posture } };
  const window = {};
  vm.runInNewContext(engine, { window, document: { getElementById: id => elements[id] } });
  window.codingSetConfig();
  return window.codingScore;
}

const score = loadScorer();
function activeCodes(report) {
  return Array.from(score(report).lines).filter(line => !line.blocked_by_ncci).map(line => line.code);
}

test("history and comparison cannot generate current procedures, keywords or add-on units", () => {
  const report = "EXAM: CT abdomen and pelvis without IV contrast.\nHISTORY: Liver biopsy last year.";
  assert.deepEqual(activeCodes(report), ["74176"]);
  assert.equal(score(report).reimbursement.total, 79.25);
  assert.deepEqual(activeCodes("HISTORY: Thyroid biopsy and liver biopsy."), []);
  assert.deepEqual(activeCodes("EXAM: CT chest without IV contrast.\nCOMPARISON: Prior thyroid biopsy."), ["71250"]);
  assert.deepEqual(activeCodes("EXAM: Liver biopsy.\nHISTORY: 22 minutes of moderate sedation last year."), ["47000"]);
});

test("a repeated phrase in the current report cites the performed occurrence", () => {
  const report = "HISTORY: Thyroid biopsy.\nPROCEDURE: Thyroid biopsy.";
  const line = score(report).lines.find(line => line.code === "60100");
  assert.ok(line);
  assert.equal(line.supporting_spans[0].start, report.lastIndexOf("Thyroid biopsy"));
  assert.deepEqual(activeCodes("Liver biopsy last year. Liver biopsy performed today."), ["47000"]);
});

test("the exam side takes precedence over history and incidental findings", () => {
  const history = "\nHISTORY: Prior left knee replacement.";
  function sides(report) {
    return Array.from(score(report).lines[0].modifiers, m => m.code).filter(code => ["LT", "RT", "50"].includes(code));
  }
  assert.deepEqual(sides("EXAM: MRI right knee without IV contrast." + history), ["RT"]);
  assert.deepEqual(sides("EXAM: MRI knee without IV contrast." + history), []);
  assert.deepEqual(sides("EXAM: MRI right knee without IV contrast.\nFINDINGS: Left knee replacement."), ["RT"]);
  assert.deepEqual(sides("EXAM: MRI both knees without IV contrast."), ["50"]);
});

test("brain MRI distinguishes all three contrast protocols", () => {
  assert.deepEqual(activeCodes("EXAM: MRI brain with IV contrast only."), ["70552"]);
  assert.equal(score("EXAM: MRI brain with IV contrast only.").reimbursement.total, 81.19);
  assert.deepEqual(activeCodes("EXAM: MRI brain without IV contrast."), ["70551"]);
  for (const contrast of ["with and without IV contrast", "without and with contrast"]) {
    assert.deepEqual(activeCodes("EXAM: MRI brain " + contrast), ["70553"]);
  }
});

test("a spelled-out CTA produces one acquisition, including with a generic CT technique", () => {
  const exam = "EXAM: CT angiography of the neck with IV contrast.";
  for (const technique of ["CTA neck with MIP on an independent workstation.", "CT images were acquired."]) {
    assert.deepEqual(activeCodes(exam + "\nTECHNIQUE: " + technique), ["70498"]);
  }
  assert.deepEqual(activeCodes("EXAM: CT neck with IV contrast."), ["70491"]);
  assert.deepEqual(activeCodes("EXAM: CT head without contrast and CTA neck with IV contrast."), ["70450", "70498"]);
  assert.deepEqual(activeCodes("EXAM: CT neck with IV contrast; separate CTA neck acquisition with IV contrast."), ["70491", "70498"]);
});

test("2D reformats do not trigger 3D charges and documented volume rendering still does", () => {
  const exam = "EXAM: CT chest with IV contrast.\nTECHNIQUE: ";
  assert.deepEqual(activeCodes(exam + "Only standard axial images and coronal MPR."), ["71260"]);
  assert.deepEqual(activeCodes(exam + "Sagittal MPR on an independent workstation."), ["71260"]);
  assert.deepEqual(activeCodes(exam + "Coronal MPR. No separate 3D rendering was performed."), ["71260"]);
  assert.deepEqual(activeCodes(exam + "3D rendering performed."), ["71260", "76376"]);
  assert.deepEqual(activeCodes(exam + "3D rendering performed on an independent workstation."), ["71260", "76377"]);
});

test("indicator 4 pays the largest professional component in full regardless of exam order", () => {
  for (const exams of ["CT head and CT chest", "CT chest and CT head"]) {
    const estimate = score("EXAM: " + exams + " without IV contrast.").reimbursement;
    assert.equal(estimate.total, 86.05);
    assert.equal(estimate.per.find(p => p.code === "71250").allowance, 49.17);
    assert.equal(estimate.per.find(p => p.code === "70450").allowance, 36.88);
  }
  assert.equal(score("EXAM: CT head without IV contrast.").reimbursement.total, 38.82);
  const vascular = score("EXAM: Ultrasound carotid and lower extremity venous duplex.").reimbursement;
  assert.deepEqual(Array.from(vascular.per, p => p.code), ["93880", "93971"]);
  assert.equal(vascular.total, vascular.naive);
});

test("global imaging fees independently rank the professional and technical components", () => {
  const globalScore = loadScorer("global");
  const estimate = globalScore("EXAM: CT abdomen and pelvis without IV contrast; MRI right knee without IV contrast.").reimbursement;
  const dollars = rvu => Math.round(rvu * 32.3465 * 100) / 100;
  assert.equal(estimate.per.find(p => p.code === "74176").allowance, dollars(2.45 + 3.14 * 0.5));
  assert.equal(estimate.per.find(p => p.code === "73721").allowance, dollars(1.91 * 0.95 + 4.28));
});

test("global vascular studies use the indicator-6 technical allowance", () => {
  const globalScore = loadScorer("global");
  const exam = "EXAM: Ultrasound carotid and lower extremity venous duplex.";
  assert.equal(globalScore(exam).reimbursement.total, 272.68);
  assert.equal(score(exam).reimbursement.total, score(exam).reimbursement.naive);
});
