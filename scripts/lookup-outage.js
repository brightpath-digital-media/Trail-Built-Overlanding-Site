/**
 * Lookup-run classifier (the circuit breaker for the evidence tiers).
 *
 * The pool build records, per run, how many Creators API lookups were LIVE and what
 * kind of failure the rest were. This module turns that into one of two verdicts:
 *
 *   LOOKUP_OUTAGE    the lookup itself is down. Systemic failures (empty result, auth or
 *                    credential rejection, throttling, transport/5xx) account for at least
 *                    90% of the lookups, or there were zero LIVE results across at least
 *                    20 ASINs with a majority of systemic failures.
 *   PRODUCT_FAILURE  anything else, including a healthy run: a minority of products failing
 *                    while others are LIVE. Those products are excluded, never carried forward.
 *
 * Pure functions, no I/O except readRunReport/writeRunReport. No credential ever enters a
 * report: counts, kinds and one masked sample only.
 */

const fs = require('fs');
const { maskSecrets, safeCode } = require('./asin-verification');

const OUTAGE_SHARE = 0.9;
const OUTAGE_MIN_ASINS_ZERO_LIVE = 20;
const ZERO_LIVE_SYSTEMIC_SHARE = 0.5;
const SYSTEMIC_KINDS = ['empty', 'auth', 'throttle', 'transport'];
const FAILURE_KINDS = [...SYSTEMIC_KINDS, 'other'];
const SAMPLE_CHARS = 200;

/** Failure kind of one verifier result, or null for LIVE. */
function failureKind(result) {
  if (!result || result.status === 'LIVE') return null;
  const code = String(result.error_code || '').toLowerCase();
  const status = Number(result.http_status || 0);
  const reason = String(result.reason || '');
  if (
    result.stage === 'auth'
    || status === 401 || status === 403
    || /missingcredentials|invalidsignature|invalidpartnertag|invalid_client|invalidclient|unauthorized|unrecognizedclient|invalidaccesskey|incompletesignature|invalid_scope|access_denied|associatenoteligible|notelig/.test(code)
  ) return 'auth';
  if (status === 429 || /toomanyrequests|throttl/.test(code) || /throttled/i.test(reason)) return 'throttle';
  if (reason === 'No items returned') return 'empty';
  if (status >= 500 || (status === 0 && /request failed|timeout/i.test(reason))) return 'transport';
  return 'other';
}

/** Verdict from run counts: { total, live, failures: { empty, auth, throttle, transport, other } }. */
function classifyCounts(counts) {
  const total = Number(counts?.total) || 0;
  const live = Number(counts?.live) || 0;
  const failures = counts?.failures || {};
  const systemic = SYSTEMIC_KINDS.reduce((sum, kind) => sum + (Number(failures[kind]) || 0), 0);
  if (total <= 0) return 'PRODUCT_FAILURE';
  if (systemic / total >= OUTAGE_SHARE) return 'LOOKUP_OUTAGE';
  if (live === 0 && total >= OUTAGE_MIN_ASINS_ZERO_LIVE && systemic / total > ZERO_LIVE_SYSTEMIC_SHARE) return 'LOOKUP_OUTAGE';
  return 'PRODUCT_FAILURE';
}

/** Summarize verifier results (array of { asin?, status, ... }) into a credential-free report. */
function buildRunReport(results, { checkedAt = new Date().toISOString(), credentials = {} } = {}) {
  const failures = Object.fromEntries(FAILURE_KINDS.map(kind => [kind, 0]));
  let live = 0;
  let sample = null;
  for (const result of results) {
    const kind = failureKind(result);
    if (kind === null) {
      live++;
      continue;
    }
    failures[kind]++;
    if (!sample && SYSTEMIC_KINDS.includes(kind)) {
      sample = {
        kind,
        http_status: Number(result.http_status || 0),
        error_code: safeCode(result.error_code, credentials),
        message: maskSecrets(result.reason || '', credentials).slice(0, SAMPLE_CHARS),
      };
    }
  }
  const counts = { total: results.length, live, failures };
  return {
    schema_version: 1,
    checked_at: checkedAt,
    ...counts,
    classification: classifyCounts(counts),
    sample,
  };
}

/** Read a run report; null when absent, unreadable, or not shaped like one (fail closed). */
function readRunReport(file) {
  if (!file) return null;
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!report || typeof report !== 'object' || !Number.isFinite(Number(report.total)) || typeof report.failures !== 'object' || report.failures === null) return null;
    return report;
  } catch {
    return null;
  }
}

function writeRunReport(file, report) {
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** The verdict is always recomputed from counts; a stored classification field is not trusted. */
function classifyRunReport(report) {
  return report ? classifyCounts(report) : null;
}

module.exports = {
  FAILURE_KINDS,
  SYSTEMIC_KINDS,
  buildRunReport,
  classifyCounts,
  classifyRunReport,
  failureKind,
  readRunReport,
  writeRunReport,
};
