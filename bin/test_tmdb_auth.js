import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config({ override: true });

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

function getArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function buildAuth() {
  const apiKey = getArg('api-key') || process.env.TMDB_API_KEY || '';
  const readToken = getArg('read-token') || process.env.TMDB_READ_TOKEN || '';

  return {
    apiKey: apiKey.trim(),
    readToken: readToken.trim(),
    hasApiKey: Boolean(apiKey.trim()),
    hasReadToken: Boolean(readToken.trim()),
  };
}

function withAuth(path, auth) {
  if (!auth.hasReadToken && auth.hasApiKey) {
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}api_key=${encodeURIComponent(auth.apiKey)}`;
  }
  return path;
}

async function callTmdb(label, path, auth, options = {}) {
  const url = `${TMDB_BASE_URL}${withAuth(path, auth)}`;
  const headers = {
    Accept: 'application/json',
    ...(auth.hasReadToken ? { Authorization: `Bearer ${auth.readToken}` } : {}),
    ...(options.headers || {})
  };

  const method = options.method || 'GET';

  console.log(`\n=== ${label} REQUEST ===`);
  console.log(JSON.stringify({ url, method, headers, body: options.body || null }, null, 2));

  const res = await fetch(url, {
    ...options,
    headers
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  console.log(`=== ${label} RESPONSE ===`);
  console.log(JSON.stringify({
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    body: data
  }, null, 2));

  return { res, data };
}

async function run() {
  const auth = buildAuth();

  if (!auth.hasApiKey && !auth.hasReadToken) {
    console.error('Missing credentials. Provide TMDB_API_KEY or TMDB_READ_TOKEN (.env or --api-key / --read-token).');
    process.exit(1);
  }

  console.log('Auth mode:', auth.hasReadToken ? 'Bearer token' : 'API key');

  // 1) Application auth call: create request token
  const tokenResult = await callTmdb('AUTH request_token', '/authentication/token/new', auth);

  // 2) Resource call: read a known movie
  await callTmdb('RESOURCE movie/11', '/movie/11', auth);

  // 3) Show interactive web auth URL (manual browser approval step)
  const requestToken = tokenResult?.data?.request_token;
  const redirectTo = getArg('redirect-to') || 'http://localhost:8888/';

  if (requestToken) {
    const authUrl = `https://www.themoviedb.org/authenticate/${encodeURIComponent(requestToken)}?redirect_to=${encodeURIComponent(redirectTo)}`;
    console.log('\n=== TMDB WEB AUTH URL (manual step) ===');
    console.log(authUrl);
  }

  // 4) Optional: create session/account if you already approved a token
  const approvedToken = getArg('approved-token') || process.env.TMDB_APPROVED_REQUEST_TOKEN;
  if (approvedToken) {
    const sessionResult = await callTmdb(
      'AUTH create_session',
      '/authentication/session/new',
      auth,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_token: approvedToken })
      }
    );

    const sessionId = sessionResult?.data?.session_id;
    if (sessionId) {
      await callTmdb('AUTH get_account', `/account?session_id=${encodeURIComponent(sessionId)}`, auth);
    }
  } else {
    console.log('\n(No approved token supplied; skipping session/account calls.)');
    console.log('Set TMDB_APPROVED_REQUEST_TOKEN in .env or pass --approved-token=<token> after approving in browser.');
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
