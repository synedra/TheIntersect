import fetch from 'node-fetch';
import https from 'https';
import fs from 'fs';

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TLS_ERROR_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
]);
const AUTH_DEBUG_VERBOSE = process.env.AUTH_DEBUG_VERBOSE !== 'false';

function shouldDisableTlsForLocalhostRuntime() {
  const runtimeUrl = process.env.URL || process.env.DEPLOY_URL || '';
  const runtimeHost = process.env.HOST || '';
  const netlifyContext = process.env.CONTEXT || '';

  const isLocalhostUrl = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(runtimeUrl);
  const isLocalhostHost = /^(localhost|127\.0\.0\.1)$/i.test(runtimeHost);
  const isDevContext = netlifyContext === 'dev';

  return isLocalhostUrl || isLocalhostHost || isDevContext;
}

if (shouldDisableTlsForLocalhostRuntime()) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

function debugLog(label, payload) {
  if (!AUTH_DEBUG_VERBOSE) return;
  try {
    console.log(`[TMDB AUTH DEBUG] ${label}`, payload);
  } catch {
    console.log(`[TMDB AUTH DEBUG] ${label}`);
  }
}

function safeParseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch (e) {
    return { _parseError: e.message, _raw: text };
  }
}

function buildHttpsAgent() {
  const isNetlifyRuntime = process.env.NETLIFY === 'true' || process.env.CONTEXT === 'production';
  const allowInsecureLocal = process.env.ALLOW_INSECURE_TLS_FOR_LOCAL_DEV === 'true' && !isNetlifyRuntime;
  const caBundlePath = process.env.TMDB_CA_BUNDLE_PATH || process.env.NODE_EXTRA_CA_CERTS;

  const options = {
    rejectUnauthorized: !allowInsecureLocal
  };

  if (caBundlePath) {
    try {
      options.ca = fs.readFileSync(caBundlePath, 'utf8');
      console.log(`[TMDB TLS] Using CA bundle from ${caBundlePath}`);
    } catch (e) {
      console.warn(`[TMDB TLS] Failed to read CA bundle at ${caBundlePath}: ${e?.message || e}`);
    }
  }

  if (allowInsecureLocal) {
    console.warn('[TMDB TLS] Insecure local TLS mode enabled (ALLOW_INSECURE_TLS_FOR_LOCAL_DEV=true). Do not use in production.');
  }

  return new https.Agent(options);
}

const httpsAgent = buildHttpsAgent();

function isTlsError(error) {
  return TLS_ERROR_CODES.has(error?.code);
}

function buildTmdbAuth(apiKey, readToken) {
  const normalizedApiKey = (apiKey || '').trim();
  const normalizedReadToken = (readToken || '').trim();

  return {
    apiKey: normalizedApiKey,
    readToken: normalizedReadToken,
    hasApiKey: normalizedApiKey.length > 0,
    hasReadToken: normalizedReadToken.length > 0,
    headers: normalizedReadToken
      ? { Authorization: `Bearer ${normalizedReadToken}` }
      : {}
  };
}

function appendApiKeyIfNeeded(path, auth, forceApiKey = false) {
  if (!forceApiKey && auth.hasReadToken) {
    return path;
  }
  if (!auth.hasApiKey) {
    return path;
  }

  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}api_key=${encodeURIComponent(auth.apiKey)}`;
}

async function tmdbFetch(path, auth, options = {}) {
  const mergedHeaders = {
    ...(auth?.headers || {}),
    ...(options.headers || {})
  };

  return fetch(`${TMDB_BASE_URL}${path}`, {
    ...options,
    headers: mergedHeaders,
    agent: httpsAgent
  });
}

async function callTmdb(label, path, auth, options = {}) {
  const method = options.method || 'GET';
  const requestHeaders = {
    ...(auth?.headers || {}),
    ...(options.headers || {})
  };
  const requestBody = options.body ?? null;
  const fullUrl = `${TMDB_BASE_URL}${path}`;

  debugLog(`${label} -> REQUEST`, {
    url: fullUrl,
    method,
    headers: requestHeaders,
    body: requestBody,
    timestamp: new Date().toISOString()
  });

  const response = await tmdbFetch(path, auth, options);
  const responseHeaders = Object.fromEntries(response.headers.entries());
  const responseText = await response.text();
  const responseData = safeParseJson(responseText);

  debugLog(`${label} <- RESPONSE`, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: responseText,
    timestamp: new Date().toISOString()
  });

  return { response, data: responseData, text: responseText };
}

async function callExternal(label, url, options = {}) {
  const method = options.method || 'GET';
  const requestHeaders = options.headers || {};
  const requestBody = options.body ?? null;

  debugLog(`${label} -> REQUEST`, {
    url,
    method,
    headers: requestHeaders,
    body: requestBody,
    timestamp: new Date().toISOString()
  });

  const response = await fetch(url, {
    ...options,
    agent: httpsAgent
  });

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const responseText = await response.text();

  debugLog(`${label} <- RESPONSE`, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: responseText,
    redirected: response.redirected,
    finalUrl: response.url,
    timestamp: new Date().toISOString()
  });

  return {
    response,
    data: safeParseJson(responseText),
    text: responseText
  };
}

export async function handler(event) {
  const auth = buildTmdbAuth(process.env.TMDB_API_KEY, process.env.TMDB_READ_TOKEN);
  if (!auth.hasApiKey && !auth.hasReadToken) {
    return { statusCode: 500, body: JSON.stringify({ error: "TMDB_API_KEY or TMDB_READ_TOKEN is required" }) };
  }

  const qs = event.queryStringParameters || {};
  const action = qs.action;
  
  let body = {};
  if (event.body) {
      try {
          body = JSON.parse(event.body);
      } catch (e) {
          console.error("Error parsing body", e);
      }
  }

  debugLog('INCOMING EVENT', {
    path: event.path,
    httpMethod: event.httpMethod,
    headers: event.headers || {},
    query: qs,
    bodyRaw: event.body || null,
    bodyParsed: body,
    timestamp: new Date().toISOString()
  });

  try {
    // 1. Create Request Token
    if (action === 'request_token') {
      const path = appendApiKeyIfNeeded('/authentication/token/new', auth);
      const result = await callTmdb('request_token', path, auth);
      debugLog('OUTGOING CLIENT RESPONSE', { action, statusCode: result.response.status, body: result.data });
      return { statusCode: result.response.status, body: JSON.stringify(result.data) };
    }

    // 1.5 Debug probe for TMDB web authenticate endpoint
    if (action === 'debug_authenticate_probe') {
      const requestToken = qs.request_token;
      const redirectTo = qs.redirect_to;

      if (!requestToken || !redirectTo) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing request_token or redirect_to' }) };
      }

      const authUrl = new URL(`https://www.themoviedb.org/authenticate/${encodeURIComponent(requestToken)}`);
      authUrl.searchParams.set('redirect_to', redirectTo);

      const { response, text } = await callExternal('debug_authenticate_probe', authUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      const probeResult = {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: text,
        finalUrl: response.url,
        redirected: response.redirected
      };

      debugLog('OUTGOING CLIENT RESPONSE', { action, statusCode: 200, body: { probe: probeResult, auth_url: authUrl.toString() } });
      return { statusCode: 200, body: JSON.stringify({ probe: probeResult, auth_url: authUrl.toString() }) };
    }

    // 2. Create Session ID
    if (action === 'create_session') {
      const requestToken = body.request_token;
      if (!requestToken) return { statusCode: 400, body: JSON.stringify({ error: "Missing request_token" }) };

      const path = appendApiKeyIfNeeded('/authentication/session/new', auth);
      const result = await callTmdb('create_session', path, auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_token: requestToken })
      });
      debugLog('OUTGOING CLIENT RESPONSE', { action, statusCode: result.response.status, body: result.data });
      return { statusCode: result.response.status, body: JSON.stringify(result.data) };
    }
    
    // 3. Get Account Details
    if (action === 'get_account') {
        const sessionId = qs.session_id;
        const accountId = qs.account_id;
        if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: "Missing session_id" }) };

        const accountPath = accountId
          ? `/account/${encodeURIComponent(accountId)}?session_id=${encodeURIComponent(sessionId)}`
          : `/account?session_id=${encodeURIComponent(sessionId)}`;
        const path = appendApiKeyIfNeeded(accountPath, auth);
        const result = await callTmdb('get_account', path, auth);
        debugLog('OUTGOING CLIENT RESPONSE', { action, statusCode: result.response.status, body: result.data });
        return { statusCode: result.response.status, body: JSON.stringify(result.data) };
    }

    // 4. Logout (Delete Session)
    if (action === 'logout') {
       const sessionId = body.session_id;
       if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: "Missing session_id" }) };

       const path = appendApiKeyIfNeeded('/authentication/session', auth);
       const result = await callTmdb('logout', path, auth, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId })
      });
      debugLog('OUTGOING CLIENT RESPONSE', { action, statusCode: result.response.status, body: result.data });
      return { statusCode: result.response.status, body: JSON.stringify(result.data) };
    }

    // 5. Get Account States for Movie/TV
    if (action === 'account_states') {
        const sessionId = qs.session_id;
        const mediaType = qs.media_type; // 'movie' or 'tv'
        const mediaId = qs.media_id;
        if (!sessionId || !mediaType || !mediaId) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required parameters" }) };
        }

        const path = appendApiKeyIfNeeded(`/${mediaType}/${mediaId}/account_states?session_id=${encodeURIComponent(sessionId)}`, auth);
        const result = await callTmdb('account_states', path, auth);
        debugLog('OUTGOING CLIENT RESPONSE', { action, statusCode: result.response.status, body: result.data });
        return { statusCode: result.response.status, body: JSON.stringify(result.data) };
    }

    // 6. Add to Watchlist
    if (action === 'add_to_watchlist') {
        const sessionId = body.session_id;
        const accountId = body.account_id;
        const mediaType = body.media_type; // 'movie' or 'tv'
        const mediaId = body.media_id;
        const watchlist = body.watchlist; // true or false

        if (!sessionId || !accountId || !mediaType || !mediaId || watchlist === undefined) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required parameters" }) };
        }

        const path = appendApiKeyIfNeeded(`/account/${accountId}/watchlist?session_id=${encodeURIComponent(sessionId)}`, auth);
        const result = await callTmdb('add_to_watchlist', path, auth, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                media_type: mediaType,
            media_id: parseInt(mediaId, 10),
                watchlist: watchlist
          })
        });
        debugLog('OUTGOING CLIENT RESPONSE', { action, statusCode: result.response.status, body: result.data });
        return { statusCode: result.response.status, body: JSON.stringify(result.data) };
    }

    // 7. Rate Movie/TV
    if (action === 'rate') {
        const sessionId = qs.session_id;
        const mediaType = qs.media_type; // 'movie' or 'tv'
        const mediaId = qs.media_id;
        const rating = body.rating; // 0.5 to 10.0 in increments of 0.5

        if (!sessionId || !mediaType || !mediaId || !rating) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required parameters" }) };
        }

        const path = appendApiKeyIfNeeded(`/${mediaType}/${mediaId}/rating?session_id=${encodeURIComponent(sessionId)}`, auth);
        const result = await callTmdb('rate', path, auth, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: parseFloat(rating) })
        });
        debugLog('OUTGOING CLIENT RESPONSE', { action, statusCode: result.response.status, body: result.data });
        return { statusCode: result.response.status, body: JSON.stringify(result.data) };
    }

    // 8. Delete Rating
    if (action === 'delete_rating') {
        const sessionId = qs.session_id;
        const mediaType = qs.media_type;
        const mediaId = qs.media_id;

        if (!sessionId || !mediaType || !mediaId) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required parameters" }) };
        }

        const path = appendApiKeyIfNeeded(`/${mediaType}/${mediaId}/rating?session_id=${encodeURIComponent(sessionId)}`, auth);
        const result = await callTmdb('delete_rating', path, auth, {
          method: 'DELETE'
        });
        debugLog('OUTGOING CLIENT RESPONSE', { action, statusCode: result.response.status, body: result.data });
        return { statusCode: result.response.status, body: JSON.stringify(result.data) };
    }

    // 9. Get User Lists
    if (action === 'get_lists') {
        const sessionId = qs.session_id;
        const accountId = qs.account_id;

        if (!sessionId || !accountId) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required parameters" }) };
        }

        const path = appendApiKeyIfNeeded(`/account/${accountId}/lists?session_id=${encodeURIComponent(sessionId)}`, auth);
        const result = await callTmdb('get_lists', path, auth);
        debugLog('OUTGOING CLIENT RESPONSE', { action, statusCode: result.response.status, body: result.data });
        return { statusCode: result.response.status, body: JSON.stringify(result.data) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Invalid action" }) };

  } catch (error) {
    console.error("TMDB Auth Error:", error);
    if (isTlsError(error)) {
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: `TLS error connecting to TMDB (${error.code}). Configure TMDB_CA_BUNDLE_PATH (or NODE_EXTRA_CA_CERTS) to trust your network CA. For local-only debugging, set ALLOW_INSECURE_TLS_FOR_LOCAL_DEV=true.`
        })
      };
    }
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
}
