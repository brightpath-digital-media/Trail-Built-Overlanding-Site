/**
 * Minimal GitHub REST helper shared by the issue-sync scripts
 * (sync-eligibility-issue.js, sync-outage-issue.js). Uses the global fetch at call time.
 * Needs a token with issues: write; ctx = { token, repo: 'owner/name' }.
 */

async function api(method, route, body, { token, repo }) {
  const response = await fetch(`https://api.github.com/repos/${repo}${route}`, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok && !(method === 'POST' && route === '/labels' && response.status === 422)) {
    throw new Error(`GitHub ${method} ${route} failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

module.exports = { api };
