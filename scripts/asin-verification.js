#!/usr/bin/env node
/**
 * Amazon Creators API verifier for pre-publish ASIN checks.
 *
 * A listing is LIVE only when GetItems returns an item. Authentication failures,
 * throttling, empty results, transport failures, and malformed responses are all
 * INCONCLUSIVE so callers preserve a fail-closed publication gate without treating
 * bot-block or transient API evidence as proof that a product is dead.
 */

const https = require('https');

const MARKETPLACE = 'www.amazon.com';
const LWA_SCOPE = 'creatorsapi::default';
const COGNITO_SCOPE = 'creatorsapi/default';
const REQUEST_INTERVAL_MS = 1000;
const LOOKUP_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCreatorsCredentials(env = process.env) {
  return {
    clientId: env.CREATORS_API_CLIENT_ID || env.CREATORS_CREDENTIAL_ID || '',
    clientSecret: env.CREATORS_API_CLIENT_SECRET || env.CREATORS_CREDENTIAL_SECRET || '',
    partnerTag: env.CREATORS_API_PARTNER_TAG || env.AMAZON_ASSOCIATE_TAG || 'trailbuiltove-20',
  };
}

function requestHttps({ hostname, path, method = 'POST', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout: 12000,
      },
      res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: raw }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

const MAX_DETAIL_CHARS = 200;

/** First API error code in a response body (never credential material). */
function apiErrorCode(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const firstError = Array.isArray(body.errors) ? body.errors[0] : null;
  const raw = firstError?.reason || firstError?.code || firstError?.type
    || body.reason || body.code || body.error || body.__type || body.type || '';
  return String(raw).split('#').pop().replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
}

/** Replace anything credential-shaped before a message is logged or published. */
function maskSecrets(text, credentials = {}) {
  let out = String(text ?? '');
  for (const secret of [credentials.clientId, credentials.clientSecret, credentials.partnerTag]) {
    if (secret && String(secret).length >= 4) out = out.split(String(secret)).join('[REDACTED]');
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/[A-Za-z0-9._~+/=-]{32,}/g, '[REDACTED]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
}

function apiMessage(payload, credentials) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const firstError = Array.isArray(body.errors) ? body.errors[0] : null;
  const raw = firstError?.message || body.message || body.error_description || '';
  return maskSecrets(raw, credentials).slice(0, MAX_DETAIL_CHARS);
}

function apiReason(response) {
  const body = parseJson(response.body);
  return apiErrorCode(body) || `HTTP ${response.status}`;
}

function createAsinVerifier({
  credentials = getCreatorsCredentials(),
  request = requestHttps,
  sleepFn = sleep,
  now = () => Date.now(),
  logger = console,
  requestIntervalMs = REQUEST_INTERVAL_MS,
  lookupAttempts = LOOKUP_ATTEMPTS,
  retryBackoffMs = RETRY_BACKOFF_MS,
} = {}) {
  let tokenCache = { token: '', expiresAt: 0 };
  let lastApiRequestAt = 0;

  async function post(hostname, path, headers, body) {
    return request({ hostname, path, method: 'POST', headers, body });
  }

  async function getAccessToken() {
    if (tokenCache.token && now() < tokenCache.expiresAt - 60000) {
      return tokenCache.token;
    }

    const cacheToken = (response, generation) => {
      const payload = parseJson(response.body);
      if (response.status < 200 || response.status >= 300 || !payload.access_token) {
        const error = new Error(`${generation} token exchange failed: ${apiReason(response)}`);
        error.code = apiErrorCode(payload);
        error.http_status = response.status;
        error.stage = 'auth';
        throw error;
      }
      tokenCache = {
        token: payload.access_token,
        expiresAt: now() + Math.max(60, payload.expires_in || 3600) * 1000,
      };
      return tokenCache.token;
    };

    try {
      const response = await post(
        'api.amazon.com',
        '/auth/o2/token',
        { 'Content-Type': 'application/json' },
        JSON.stringify({
          grant_type: 'client_credentials',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          scope: LWA_SCOPE,
        })
      );
      return cacheToken(response, 'LwA v3');
    } catch (v3Error) {
      const basicAuth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
      try {
        const response = await post(
          'creatorsapi.auth.us-east-1.amazoncognito.com',
          '/oauth2/token',
          {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basicAuth}`,
          },
          `grant_type=client_credentials&scope=${encodeURIComponent(COGNITO_SCOPE)}`
        );
        return cacheToken(response, 'Cognito v2');
      } catch (v2Error) {
        const authError = new Error(`Creators API authentication was inconclusive after LwA v3 and Cognito v2: ${v3Error.message}; ${v2Error.message}`);
        authError.code = v3Error.code || v2Error.code || '';
        authError.http_status = v3Error.http_status || v2Error.http_status || 0;
        authError.stage = 'auth';
        throw authError;
      }
    }
  }

  async function pace() {
    const waitMs = requestIntervalMs - (now() - lastApiRequestAt);
    if (waitMs > 0) await sleepFn(waitMs);
    lastApiRequestAt = now();
  }

  async function lookupOnce(asin) {
    await pace();
    const token = await getAccessToken();
    const response = await post(
      'creatorsapi.amazon',
      '/catalog/v1/getItems',
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-marketplace': MARKETPLACE,
      },
      JSON.stringify({
        itemIds: [asin],
        itemIdType: 'ASIN',
        marketplace: MARKETPLACE,
        partnerTag: credentials.partnerTag,
        partnerType: 'Associates',
        resources: ['itemInfo.title', 'images.primary.large'],
      })
    );
    const payload = parseJson(response.body);
    const items = payload?.itemResults?.items || payload?.itemsResult?.items || [];
    if (response.status >= 200 && response.status < 300 && items.length > 0) {
      return {
        status: 'LIVE',
        source: 'creators_api',
        title: items[0]?.itemInfo?.title?.displayValue || '',
        image_url: items[0]?.images?.primary?.large?.url || '',
        reason: '',
      };
    }
    const ok = response.status >= 200 && response.status < 300;
    const code = apiErrorCode(payload);
    const detail = apiMessage(payload, credentials);
    let reason;
    if (response.status === 429) reason = 'Creators API throttled the lookup';
    else if (ok) reason = 'No items returned';
    else reason = `HTTP ${response.status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`.slice(0, MAX_DETAIL_CHARS + 80);
    return {
      status: 'INCONCLUSIVE',
      source: 'creators_api',
      title: '',
      image_url: '',
      http_status: response.status,
      error_code: response.status === 429 && !code ? 'TooManyRequests' : code,
      reason,
    };
  }

  async function verifyAsin(asin) {
    if (!/^[A-Z0-9]{10}$/.test(asin || '')) {
      return { status: 'INCONCLUSIVE', source: 'input', title: '', image_url: '', reason: 'Invalid ASIN format' };
    }
    if (!credentials.clientId || !credentials.clientSecret || !credentials.partnerTag) {
      return { status: 'INCONCLUSIVE', source: 'creators_api', title: '', image_url: '', stage: 'auth', error_code: 'MissingCredentials', reason: 'Creators API credentials are unavailable' };
    }

    let lastResult = { status: 'INCONCLUSIVE', source: 'creators_api', title: '', image_url: '', reason: 'Creators API lookup unavailable' };
    for (let attempt = 1; attempt <= lookupAttempts; attempt++) {
      try {
        lastResult = await lookupOnce(asin);
        if (lastResult.status === 'LIVE') return { ...lastResult, attempts: attempt };
      } catch (error) {
        lastResult = {
          status: 'INCONCLUSIVE',
          source: 'creators_api',
          title: '',
          image_url: '',
          stage: error.stage || '',
          http_status: error.http_status || 0,
          error_code: String(error.code || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64),
          reason: `Creators API request failed: ${maskSecrets(error.message, credentials).slice(0, MAX_DETAIL_CHARS)}`,
        };
      }
      if (attempt < lookupAttempts) {
        logger.warn(`[asin-precheck] ${asin}: ${lastResult.reason}; retrying ${attempt + 1}/${lookupAttempts}.`);
        await sleepFn(retryBackoffMs * attempt);
      }
    }
    return { ...lastResult, attempts: lookupAttempts };
  }

  return { verifyAsin };
}

module.exports = {
  apiErrorCode,
  createAsinVerifier,
  maskSecrets,
  getCreatorsCredentials,
  requestHttps,
};
