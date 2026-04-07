import fetch from 'node-fetch';
import https from 'https';

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

// Create an HTTPS agent that handles SSL in development
// In production (Netlify), this won't be needed as certificates work properly
const httpsAgent = new https.Agent({
  rejectUnauthorized: process.env.NETLIFY !== 'true' ? false : true
});

export async function handler(event) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "TMDB_API_KEY missing" }) };
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

  try {
    // 1. Create Request Token
    if (action === 'request_token') {
      const response = await fetch(`${TMDB_BASE_URL}/authentication/token/new?api_key=${apiKey}`, {
        agent: httpsAgent
      });
      const data = await response.json();
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    // 2. Create Session ID
    if (action === 'create_session') {
      const requestToken = body.request_token;
      if (!requestToken) return { statusCode: 400, body: JSON.stringify({ error: "Missing request_token" }) };

      const response = await fetch(`${TMDB_BASE_URL}/authentication/session/new?api_key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_token: requestToken }),
        agent: httpsAgent
      });
      const data = await response.json();
      return { statusCode: 200, body: JSON.stringify(data) };
    }
    
    // 3. Get Account Details
    if (action === 'get_account') {
        const sessionId = qs.session_id;
        if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: "Missing session_id" }) };

        const response = await fetch(`${TMDB_BASE_URL}/account?api_key=${apiKey}&session_id=${sessionId}`, {
          agent: httpsAgent
        });
        const data = await response.json();
        return { statusCode: 200, body: JSON.stringify(data) };
    }

    // 4. Logout (Delete Session)
    if (action === 'logout') {
       const sessionId = body.session_id;
       if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: "Missing session_id" }) };

       const response = await fetch(`${TMDB_BASE_URL}/authentication/session?api_key=${apiKey}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
        agent: httpsAgent
      });
      const data = await response.json();
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    // 5. Get Account States for Movie/TV
    if (action === 'account_states') {
        const sessionId = qs.session_id;
        const mediaType = qs.media_type; // 'movie' or 'tv'
        const mediaId = qs.media_id;
        if (!sessionId || !mediaType || !mediaId) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required parameters" }) };
        }

        const response = await fetch(`${TMDB_BASE_URL}/${mediaType}/${mediaId}/account_states?api_key=${apiKey}&session_id=${sessionId}`, {
            agent: httpsAgent
        });
        const data = await response.json();
        return { statusCode: 200, body: JSON.stringify(data) };
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

        const response = await fetch(`${TMDB_BASE_URL}/account/${accountId}/watchlist?api_key=${apiKey}&session_id=${sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                media_type: mediaType,
                media_id: parseInt(mediaId),
                watchlist: watchlist
            }),
            agent: httpsAgent
        });
        const data = await response.json();
        return { statusCode: 200, body: JSON.stringify(data) };
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

        const response = await fetch(`${TMDB_BASE_URL}/${mediaType}/${mediaId}/rating?api_key=${apiKey}&session_id=${sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: parseFloat(rating) }),
            agent: httpsAgent
        });
        const data = await response.json();
        return { statusCode: 200, body: JSON.stringify(data) };
    }

    // 8. Delete Rating
    if (action === 'delete_rating') {
        const sessionId = qs.session_id;
        const mediaType = qs.media_type;
        const mediaId = qs.media_id;

        if (!sessionId || !mediaType || !mediaId) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required parameters" }) };
        }

        const response = await fetch(`${TMDB_BASE_URL}/${mediaType}/${mediaId}/rating?api_key=${apiKey}&session_id=${sessionId}`, {
            method: 'DELETE',
            agent: httpsAgent
        });
        const data = await response.json();
        return { statusCode: 200, body: JSON.stringify(data) };
    }

    // 9. Get User Lists
    if (action === 'get_lists') {
        const sessionId = qs.session_id;
        const accountId = qs.account_id;

        if (!sessionId || !accountId) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required parameters" }) };
        }

        const response = await fetch(`${TMDB_BASE_URL}/account/${accountId}/lists?api_key=${apiKey}&session_id=${sessionId}`, {
            agent: httpsAgent
        });
        const data = await response.json();
        return { statusCode: 200, body: JSON.stringify(data) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Invalid action" }) };

  } catch (error) {
    console.error("TMDB Auth Error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
}
