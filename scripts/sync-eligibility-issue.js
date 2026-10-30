#!/usr/bin/env node
/**
 * Publish the eligibility probe result to ONE public GitHub issue,
 * "Amazon API eligibility". The body is rewritten on every run; a comment is added
 * only when the state changes from the previous run, so the issue stays quiet
 * while the answer is stable. Reads probe-result.json (see amazon-eligibility-probe.js).
 *
 * Needs GITHUB_TOKEN with issues: write and GITHUB_REPOSITORY (set by Actions).
 */

const fs = require('fs');
const { STATES } = require('./amazon-eligibility-probe');

const TITLE = 'Amazon API eligibility';
const LABEL = 'lookup-outage';
const STATE_MARKER = /<!--\s*eligibility-state:\s*([A-Z_]+)\s*-->/;

const MEANING = {
  ELIGIBLE: 'The Creators API answered a lookup. Live verification works.',
  NOT_ELIGIBLE: 'Amazon reports the Associates account is not eligible for the Creators API. Live verification will not work until eligibility returns.',
  CREDENTIAL_ERROR: 'Credentials, signature or partner tag were rejected or are missing. Check the repository secrets.',
  THROTTLED: 'The API throttled the lookup. Try again later; no action needed unless it persists.',
  UNKNOWN: 'The lookup failed in a way that does not identify the cause (empty result, server error or network). Check the next run.',
};

function parsePreviousState(body) {
  const match = STATE_MARKER.exec(body || '');
  return match && STATES.includes(match[1]) ? match[1] : '';
}

function renderBody(result) {
  return [
    `<!-- eligibility-state: ${result.state} -->`,
    `# Amazon API eligibility: ${result.state}`,
    '',
    MEANING[result.state] || MEANING.UNKNOWN,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| State | ${result.state} |`,
    `| HTTP status | ${result.http_status || 'n/a'} |`,
    `| Error code | ${result.error_code || 'none'} |`,
    `| Message (masked, max 200 chars) | ${(result.message || 'none').replace(/\|/g, '/')} |`,
    `| Probed pool ASIN | ${result.asin} |`,
    `| Checked at (UTC) | ${result.checked_at} |`,
    '',
    'One lookup of one pool ASIN per day with the repository secrets, from `.github/workflows/amazon-api-eligibility.yml`. This body is rewritten each run; a comment is posted only when the state changes. No credential is ever shown here.',
    '',
  ].join('\n');
}

function shouldComment(previousState, newState) {
  return Boolean(previousState) && previousState !== newState;
}

function renderComment(previousState, result) {
  return `State changed: ${previousState} -> ${result.state} (HTTP ${result.http_status || 'n/a'}, code ${result.error_code || 'none'}) at ${result.checked_at}.`;
}

async function api(method, route, body, { token, repo }) {
  const response = await fetch(`https://api.github.com/repos/${repo}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok && !(method === 'POST' && route === '/labels' && response.status === 422)) {
    throw new Error(`GitHub ${method} ${route} failed: HTTP ${response.status}`);
  }
  return data;
}

async function sync(result, ctx) {
  await api('POST', '/labels', { name: LABEL, color: 'd93f0b', description: 'Amazon API lookup health' }, ctx);
  const issues = await api('GET', `/issues?labels=${LABEL}&state=all&per_page=100`, null, ctx);
  const existing = (Array.isArray(issues) ? issues : []).find(issue => issue.title === TITLE && !issue.pull_request);
  const body = renderBody(result);
  if (!existing) {
    const created = await api('POST', '/issues', { title: TITLE, body, labels: [LABEL] }, ctx);
    return { action: 'created', number: created.number, commented: false };
  }
  const previousState = parsePreviousState(existing.body);
  await api('PATCH', `/issues/${existing.number}`, { body, state: 'open' }, ctx);
  const commented = shouldComment(previousState, result.state);
  if (commented) await api('POST', `/issues/${existing.number}/comments`, { body: renderComment(previousState, result) }, ctx);
  return { action: 'updated', number: existing.number, commented };
}

async function main(argv = process.argv.slice(2)) {
  const file = argv[0] || 'probe-result.json';
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!STATES.includes(result.state)) throw new Error(`Unexpected state in ${file}`);
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const outcome = await sync(result, { token, repo });
  console.log(`[eligibility-issue] ${outcome.action} #${outcome.number}${outcome.commented ? ' (state-change comment posted)' : ''}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[eligibility-issue] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { TITLE, LABEL, parsePreviousState, renderBody, renderComment, shouldComment, sync };
