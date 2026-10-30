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

  // Hostile responses: a credential-shaped value in any code field must never survive.
  const token40 = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd';
  for (const hostile of [
    { reason: CREDENTIALS.clientSecret },
    { errors: [{ code: CREDENTIALS.clientId }] },
    { __type: `com.amazon#${CREDENTIALS.clientSecret}` },
    { reason: token40 },
    { code: `${CREDENTIALS.partnerTag}` },
    { type: 'x'.repeat(200) },
  ]) {
    const r = await probeWith({ status: 403, body: JSON.stringify(hostile) });
    const published = JSON.stringify(r) + issue.renderBody(r) + issue.renderComment('ELIGIBLE', r);
    for (const secret of [CREDENTIALS.clientSecret, CREDENTIALS.clientId, CREDENTIALS.partnerTag, token40]) {
      assert.ok(!published.includes(secret), `a secret leaked through the error code for ${JSON.stringify(hostile).slice(0, 40)}`);
    }
    assert.strictEqual(r.error_code, '', 'a credential-shaped code is dropped, not shown');
  }
  assert.strictEqual((await probeWith({ status: 403, body: JSON.stringify({ reason: 'AccessDeniedException' }) })).error_code, 'AccessDeniedException', 'a normal code is kept');

  // Token-exchange failures: rejected is a credential problem; throttle, 5xx and transport are not.
  assert.strictEqual((await probeWith({ status: 200, body: '{}' }, { status: 429, body: '{}' })).state, 'THROTTLED');
  assert.strictEqual((await probeWith({ status: 200, body: '{}' }, { status: 500, body: 'oops' })).state, 'UNKNOWN');
  assert.strictEqual((await probeWith({ status: 200, body: '{}' }, { status: 503, body: '' })).state, 'UNKNOWN');
  assert.strictEqual((await probeWith({ status: 200, body: '{}' }, { status: 400, body: JSON.stringify({ error: 'invalid_client' }) })).state, 'CREDENTIAL_ERROR');
  const transportVerifier = createAsinVerifier({
    credentials: CREDENTIALS, requestIntervalMs: 0, lookupAttempts: 1, sleepFn: async () => {},
    request: async () => { throw new Error('socket hang up'); },
  });
  const transport = await runProbe({ verifier: transportVerifier, products: PRODUCTS, credentials: CREDENTIALS, now: () => 0 });
  assert.strictEqual(transport.state, 'UNKNOWN', 'a transport failure is not a credential error');

  // Issue sync ordering and reopen rules.
  const log = [];
  let failComment = false;
  const store = [{ number: 9, title: issue.TITLE, state: 'closed', body: issue.renderBody({ ...notEligible, state: 'NOT_ELIGIBLE' }) }];
  global.fetch = async (url, options) => {
    const route = String(url).replace('https://api.github.com/repos/o/r', '').split('?')[0];
    log.push(`${options.method} ${route}${options.body && JSON.parse(options.body).state ? ' state=' + JSON.parse(options.body).state : ''}`);
    if (route === '/labels') return new Response('{}', { status: 201 });
    if (options.method === 'GET') return new Response(JSON.stringify(store), { status: 200 });
    if (route.endsWith('/comments')) return failComment ? new Response('<html>bad gateway</html>', { status: 502 }) : new Response('{}', { status: 201 });
    if (options.method === 'PATCH') { store[0].body = JSON.parse(options.body).body; return new Response('{}', { status: 200 }); }
    throw new Error('unexpected');
  };
  try {
    const ctx = { token: 't', repo: 'o/r' };
    // Same state on a deliberately closed issue: body refreshed, issue stays closed, no comment.
    await issue.sync(notEligible, ctx);
    assert.ok(!log.some(l => l.includes('state=open')), 'a closed issue is not reopened when the state is unchanged');
    assert.ok(!log.some(l => l.endsWith('/comments')), 'no comment when unchanged');
    // State change with a failing comment POST: the stored marker must still be the old state.
    failComment = true;
    log.length = 0;
    await assert.rejects(() => issue.sync(eligible, ctx), /failed: HTTP 502/, 'a non-JSON error body still reports the HTTP status');
    assert.strictEqual(issue.parsePreviousState(store[0].body), 'NOT_ELIGIBLE', 'marker unchanged so the next run retries the comment');
    assert.ok(!log.some(l => l.startsWith('PATCH')), 'no PATCH before the comment succeeded');
    // Retry succeeds: comment, then reopen and update.
    failComment = false;
    log.length = 0;
    await issue.sync(eligible, ctx);
    assert.ok(log.findIndex(l => l.endsWith('/comments')) < log.findIndex(l => l.startsWith('PATCH')), 'comment is posted before the PATCH');
    assert.ok(log.some(l => l.includes('state=open')), 'a real state change reopens the issue');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('Eligibility probe tests passed: classification, masking, issue body, comment-on-change.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
