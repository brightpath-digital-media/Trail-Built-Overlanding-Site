#!/usr/bin/env node
/**
 * Daily Amazon Creators API eligibility probe.
 *
 * Makes ONE GetItems lookup for ONE pool ASIN with the repository's existing
 * Creators API secrets, classifies the answer, and writes a small JSON result
 * (state, HTTP status, masked error code, checked_at). It never fails the job on
 * an unfavourable answer: the answer is the data. Nothing credential-shaped is
 * ever written; messages are masked and truncated to 200 characters.
 *
 * States:
 *   ELIGIBLE         the lookup returned an item
 *   NOT_ELIGIBLE     the account is not eligible for the Creators API (AssociateNotEligible)
 *   CREDENTIAL_ERROR missing or rejected credentials, signature or partner tag
 *   THROTTLED        the API throttled the lookup (HTTP 429)
 *   UNKNOWN          anything else (empty result, 5xx, transport failure)
 *
 * Usage: node scripts/amazon-eligibility-probe.js [--out probe-result.json]
 */

const fs = require('fs');
const path = require('path');
const { createAsinVerifier, getCreatorsCredentials, maskSecrets, safeCode } = require('./asin-verification');

const POOL_FILE = path.join(__dirname, '..', 'data', 'verified-products.json');
const STATES = ['ELIGIBLE', 'NOT_ELIGIBLE', 'CREDENTIAL_ERROR', 'THROTTLED', 'UNKNOWN'];

function classifyLookup(result) {
  if (result && result.status === 'LIVE') return 'ELIGIBLE';
  const code = String(result?.error_code || '').toLowerCase();
  const status = Number(result?.http_status || 0);
  const reason = String(result?.reason || '');
  if (/associatenoteligible|notelig/.test(code) || (status === 403 && /not (currently )?eligible|eligibility requirement/i.test(reason))) {
    return 'NOT_ELIGIBLE';
  }
  const credentialCode = /invalidsignature|invalidpartnertag|invalid_client|invalidclient|unauthorized|unrecognizedclient|invalidaccesskey|incompletesignature|missingcredentials|invalid_scope|access_denied/.test(code);
  // A token-exchange failure is a credential problem only when the endpoint rejected the
  // request (400/401/403) or named a credential error; throttling, 5xx and transport
  // failures during the exchange are not.
  const authRejected = result?.stage === 'auth' && [400, 401, 403].includes(status);
  if (status === 429 || /toomanyrequests|throttl/.test(code) || /throttled/i.test(reason)) return 'THROTTLED';
  if (authRejected || status === 401 || credentialCode) return 'CREDENTIAL_ERROR';
  return 'UNKNOWN';
}

function pickProbeAsin(products, now = Date.now(), override = '') {
  if (/^[A-Z0-9]{10}$/.test(override || '')) return override;
  if (!Array.isArray(products) || products.length === 0) throw new Error('Product pool is empty');
  const day = Math.floor(now / 86400000);
  return products[day % products.length].asin;
}

async function runProbe({ verifier, products, credentials = {}, now = () => Date.now(), asinOverride = '' }) {
  const asin = pickProbeAsin(products, now(), asinOverride);
  const result = await verifier.verifyAsin(asin);
  const state = classifyLookup(result);
  return {
    state,
    http_status: Number(result.http_status || (result.status === 'LIVE' ? 200 : 0)),
    error_code: safeCode(result.error_code, credentials),
    message: result.status === 'LIVE' ? '' : maskSecrets(result.reason || '', credentials).slice(0, 200),
    asin,
    checked_at: new Date(now()).toISOString(),
  };
}

function summaryMarkdown(r) {
  return [
    '## Amazon Creators API eligibility probe',
    '',
    `- State: **${r.state}**`,
    `- HTTP status: ${r.http_status || 'n/a'}`,
    `- Error code: ${r.error_code || 'none'}`,
    `- Message: ${r.message || 'none'}`,
    `- Probed ASIN: ${r.asin}`,
    `- Checked at (UTC): ${r.checked_at}`,
    '',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const outIndex = argv.indexOf('--out');
  const outFile = outIndex >= 0 ? argv[outIndex + 1] : 'probe-result.json';
  const credentials = getCreatorsCredentials();
  const products = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')).products;
  const verifier = createAsinVerifier({ credentials, lookupAttempts: 1, requestIntervalMs: 0 });
  const result = await runProbe({ verifier, products, credentials, asinOverride: process.env.PROBE_ASIN || '' });
  fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
  const summary = summaryMarkdown(result);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return result;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[eligibility-probe] failed: ${maskSecrets(error.message, getCreatorsCredentials())}`);
    process.exit(1);
  });
}

module.exports = { STATES, classifyLookup, pickProbeAsin, runProbe, summaryMarkdown };
