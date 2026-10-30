#!/usr/bin/env node
/**
 * Publish the lookup-run verdict to ONE public GitHub issue, "Amazon lookup outage"
 * (label lookup-outage; the same label sync-eligibility-issue.js uses, told apart by title).
 *
 *   LOOKUP_OUTAGE     create the issue, or update its body (and reopen it if closed, with a
 *                     comment, because a new outage started).
 *   anything else     if the issue is open and at least half of the lookups were LIVE, post a
 *                     recovery comment and close it. Otherwise do nothing: no issue is created for a
 *                     healthy run.
 *
 * Reads the run report written by `build-verified-pool.mjs --verify --run-report <file>`.
 * The body holds counts, failure kinds, one masked sample and the run URL. Never a credential:
 * every free-text value is masked again here and truncated to 200 characters.
 *
 * Needs GITHUB_TOKEN with issues: write and GITHUB_REPOSITORY (set by Actions).
 * `--dry-run` prints the body and writes nothing.
 */

const { api } = require('./github-issues-api');
const { classifyRunReport, readRunReport, FAILURE_KINDS } = require('./lookup-outage');
const { getCreatorsCredentials, maskSecrets, safeCode } = require('./asin-verification');

const TITLE = 'Amazon lookup outage';
const LABEL = 'lookup-outage';
const MAX_TEXT = 200;
const RECOVERY_LIVE_SHARE = 0.5;
const STATE_MARKER = /<!--\s*outage-state:\s*([A-Z_]+)\s*-->/;

const MEANING = {
  LOOKUP_OUTAGE: 'The Creators API lookup is down for (nearly) every product, so live verification could not run. Product-level failures are not counted here.',
  RECOVERED: 'The lookup answers again; Tier 1 verification resumed.',
};

function clean(value, credentials) {
  return maskSecrets(String(value ?? ''), credentials).replace(/\|/g, '/').slice(0, MAX_TEXT);
}

function renderBody(report, { credentials = {}, runUrl = '', carryForwardEnabled = false, state = 'LOOKUP_OUTAGE' } = {}) {
  const failures = report.failures || {};
  const sample = report.sample || null;
  const rows = [
    ['Verdict', state],
    ['Lookups', `${Number(report.total) || 0}`],
    ['LIVE', `${Number(report.live) || 0}`],
    ...FAILURE_KINDS.map(kind => [`Failed: ${kind}`, `${Number(failures[kind]) || 0}`]),
    ['Sample HTTP status', sample ? `${Number(sample.http_status) || 'n/a'}` : 'n/a'],
    ['Sample error code', sample ? (safeCode(sample.error_code, credentials) || 'none') : 'none'],
    ['Sample message (masked, max 200 chars)', sample ? (clean(sample.message, credentials) || 'none') : 'none'],
    ['Carry-forward enabled (ALLOW_CARRY_FORWARD)', carryForwardEnabled ? 'yes' : 'no'],
    ['Checked at (UTC)', clean(report.checked_at, credentials)],
    ['Workflow run', runUrl || 'n/a'],
  ];
  return [
    `<!-- outage-state: ${state} -->`,
    `# Amazon lookup outage: ${state}`,
    '',
    MEANING[state] || MEANING.LOOKUP_OUTAGE,
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([field, value]) => `| ${field} | ${value} |`),
    '',
    'Written by `scripts/sync-outage-issue.js` from the weekly content workflow. See also the "Amazon API eligibility" issue for the cause. Without carry-forward enabled, publishing fails closed while this is open. No credential is ever shown here.',
    '',
  ].join('\n');
}

async function sync(report, ctx, { credentials = {}, runUrl = '', carryForwardEnabled = false, dryRun = false } = {}) {
  const verdict = classifyRunReport(report);
  const outage = verdict === 'LOOKUP_OUTAGE';
  const body = renderBody(report, { credentials, runUrl, carryForwardEnabled, state: outage ? 'LOOKUP_OUTAGE' : 'RECOVERED' });
  if (dryRun) {
    console.log(body);
    return { action: 'dry-run', verdict };
  }
  const issues = await api('GET', `/issues?labels=${LABEL}&state=all&per_page=100`, null, ctx);
  const existing = (Array.isArray(issues) ? issues : []).find(issue => issue.title === TITLE && !issue.pull_request);
  const stamp = clean(report.checked_at, credentials);

  if (outage) {
    if (!existing) {
      await api('POST', '/labels', { name: LABEL, color: 'd93f0b', description: 'Amazon API lookup health' }, ctx);
      const created = await api('POST', '/issues', { title: TITLE, body, labels: [LABEL] }, ctx);
      return { action: 'created', number: created.number, verdict };
    }
    const wasClosed = existing.state === 'closed';
    // Comment first: if it fails the body is unchanged and the next run retries.
    if (wasClosed) await api('POST', `/issues/${existing.number}/comments`, { body: `Lookup outage detected again at ${stamp}.` }, ctx);
    await api('PATCH', `/issues/${existing.number}`, wasClosed ? { body, state: 'open' } : { body }, ctx);
    return { action: wasClosed ? 'reopened' : 'updated', number: existing.number, verdict };
  }

  // Not an outage. Close only an open issue, and only on clear recovery: at least half of the
  // lookups LIVE. A mostly-failing lookup with a few LIVE hits is not recovered (hysteresis).
  const liveShare = Number(report.total) > 0 ? Number(report.live) / Number(report.total) : 0;
  if (existing && existing.state === 'open' && liveShare >= RECOVERY_LIVE_SHARE) {
    await api('POST', `/issues/${existing.number}/comments`, { body: `Lookup recovered at ${stamp}: ${Number(report.live)} of ${Number(report.total)} lookups were LIVE. Tier 1 verification resumed; closing.` }, ctx);
    await api('PATCH', `/issues/${existing.number}`, { body, state: 'closed' }, ctx);
    return { action: 'closed', number: existing.number, verdict };
  }
  return { action: 'none', verdict };
}

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const file = argv.find(arg => !arg.startsWith('--'));
  const report = readRunReport(file);
  if (!report) {
    console.log('[outage-issue] No usable run report; nothing to publish.');
    return;
  }
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!dryRun && (!token || !repo)) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const runUrl = process.env.GITHUB_SERVER_URL && repo && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';
  const outcome = await sync(report, { token, repo }, {
    credentials: getCreatorsCredentials(),
    runUrl,
    carryForwardEnabled: process.env.ALLOW_CARRY_FORWARD === 'true',
    dryRun,
  });
  console.log(`[outage-issue] ${outcome.verdict}: ${outcome.action}${outcome.number ? ` #${outcome.number}` : ''}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[outage-issue] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { TITLE, LABEL, renderBody, sync, STATE_MARKER };
