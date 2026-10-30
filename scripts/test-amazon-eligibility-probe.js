#!/usr/bin/env node
/**
 * Local tests for the Amazon eligibility probe: lookup classification, secret
 * masking and the "comment only on state change" issue sync. Mocked HTTP only;
 * no network and no credentials.
 */

const assert = require('assert');
const { createAsinVerifier } = require('./asin-verification');
const { classifyLookup, pickProbeAsin, runProbe } = require('./amazon-eligibility-probe');
const issue = require('./sync-eligibility-issue');

const CREDENTIALS = { clientId: 'client-id-value-1234', clientSecret: 'client-secret-value-5678', partnerTag: 'testtag-20' };
const TOKEN_OK = { status: 200, body: JSON.stringify({ access_token: 'tok', expires_in: 3600 }) };
const PRODUCTS = [{ asin: 'B000000001' }, { asin: 'B000000002' }, { asin: 'B000000003' }];

function probeWith(catalog, token = TOKEN_OK) {
  const verifier = createAsinVerifier({
    credentials: CREDENTIALS,
    requestIntervalMs: 0,
    lookupAttempts: 1,
    sleepFn: async () => {},
    request: async request => (request.hostname === 'creatorsapi.amazon' ? catalog : token),
  });
  return runProbe({ verifier, products: PRODUCTS, credentials: CREDENTIALS, now: () => Date.UTC(2026, 9, 30, 13, 23, 0) });
}

async function run() {
  const item = { itemResults: { items: [{ asin: 'B000000002', itemInfo: { title: { displayValue: 'A Product' } } }] } };
  const eligible = await probeWith({ status: 200, body: JSON.stringify(item) });
  assert.strictEqual(eligible.state, 'ELIGIBLE');
  assert.strictEqual(eligible.http_status, 200);
  assert.strictEqual(eligible.checked_at, '2026-10-30T13:23:00.000Z');

  const notEligible = await probeWith({
    status: 403,
    body: JSON.stringify({ type: 'AccessDeniedException', reason: 'AssociateNotEligible', message: `Your account does not currently meet the eligibility requirements. ${CREDENTIALS.partnerTag}` }),
  });
  assert.strictEqual(notEligible.state, 'NOT_ELIGIBLE');
  assert.strictEqual(notEligible.http_status, 403);
  assert.strictEqual(notEligible.error_code, 'AssociateNotEligible');
  assert.ok(!notEligible.message.includes(CREDENTIALS.partnerTag), 'partner tag must be masked');
  assert.ok(notEligible.message.length <= 200);

  const badTag = await probeWith({ status: 403, body: JSON.stringify({ errors: [{ code: 'InvalidPartnerTag', message: 'bad tag' }] }) });
  assert.strictEqual(badTag.state, 'CREDENTIAL_ERROR');
  assert.strictEqual(badTag.error_code, 'InvalidPartnerTag');

  const badToken = await probeWith(
    { status: 200, body: '{}' },
    { status: 401, body: JSON.stringify({ error: 'invalid_client', error_description: `client ${CREDENTIALS.clientSecret} rejected` }) }
  );
  assert.strictEqual(badToken.state, 'CREDENTIAL_ERROR');
  assert.ok(!JSON.stringify(badToken).includes(CREDENTIALS.clientSecret), 'client secret must never appear');
  assert.ok(!JSON.stringify(badToken).includes(CREDENTIALS.clientId), 'client id must never appear');

  const missing = await runProbe({
    verifier: createAsinVerifier({ credentials: { clientId: '', clientSecret: '', partnerTag: 'testtag-20' } }),
    products: PRODUCTS,
    now: () => 0,
  });
  assert.strictEqual(missing.state, 'CREDENTIAL_ERROR');
  assert.strictEqual(missing.error_code, 'MissingCredentials');

  const throttled = await probeWith({ status: 429, body: '{}' });
  assert.strictEqual(throttled.state, 'THROTTLED');
  assert.strictEqual(throttled.http_status, 429);

  assert.strictEqual((await probeWith({ status: 200, body: JSON.stringify({ itemResults: { items: [] } }) })).state, 'UNKNOWN');
  assert.strictEqual((await probeWith({ status: 503, body: 'upstream error' })).state, 'UNKNOWN');

  assert.strictEqual(classifyLookup({ status: 'INCONCLUSIVE', http_status: 403, reason: 'HTTP 403: Your account is not currently eligible' }), 'NOT_ELIGIBLE');
  assert.strictEqual(pickProbeAsin(PRODUCTS, Date.UTC(2026, 9, 30)), PRODUCTS[Math.floor(Date.UTC(2026, 9, 30) / 86400000) % 3].asin);
  assert.strictEqual(pickProbeAsin(PRODUCTS, 0, 'B0ABCDEFGH'), 'B0ABCDEFGH');

  // Issue body and comment-on-change rules.
  const body = issue.renderBody(notEligible);
  assert.strictEqual(issue.parsePreviousState(body), 'NOT_ELIGIBLE');
  assert.ok(body.includes('checked_at') === false && body.includes(notEligible.checked_at));
  assert.ok(!body.includes(CREDENTIALS.clientSecret));
  assert.strictEqual(issue.shouldComment('', 'NOT_ELIGIBLE'), false, 'no comment on first run');
  assert.strictEqual(issue.shouldComment('NOT_ELIGIBLE', 'NOT_ELIGIBLE'), false, 'no comment when state is unchanged');
  assert.strictEqual(issue.shouldComment('NOT_ELIGIBLE', 'ELIGIBLE'), true, 'comment on change');

  // sync() against a fake GitHub API.
  const calls = [];
  const issues = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const route = String(url).replace('https://api.github.com/repos/o/r', '');
    const method = options.method;
    calls.push(`${method} ${route.split('?')[0]}`);
    const reply = (status, data) => new Response(JSON.stringify(data), { status });
    if (route === '/labels') return reply(201, {});
    if (method === 'GET') return reply(200, issues);
    if (method === 'POST' && route === '/issues') {
      const created = { number: 7, title: JSON.parse(options.body).title, body: JSON.parse(options.body).body };
      issues.push(created);
      return reply(201, created);
    }
    if (method === 'PATCH') {
      issues[0].body = JSON.parse(options.body).body;
      return reply(200, issues[0]);
    }
    if (method === 'POST') return reply(201, {});
    throw new Error(`unexpected ${method} ${route}`);
  };
  try {
    const ctx = { token: 't', repo: 'o/r' };
    assert.deepStrictEqual(await issue.sync(notEligible, ctx), { action: 'created', number: 7, commented: false });
    assert.deepStrictEqual(await issue.sync(notEligible, ctx), { action: 'updated', number: 7, commented: false });
    assert.deepStrictEqual(await issue.sync(eligible, ctx), { action: 'updated', number: 7, commented: true });
    assert.strictEqual(calls.filter(c => c === 'POST /issues/7/comments').length, 1, 'exactly one state-change comment');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('Eligibility probe tests passed: classification, masking, issue body, comment-on-change.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
