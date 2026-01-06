import fetch from 'node-fetch';

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

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
      const response = await fetch(`${TMDB_BASE_URL}/authentication/token/new?api_key=${apiKey}`);
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
        body: JSON.stringify({ request_token: requestToken })
      });
      const data = await response.json();
      return { statusCode: 200, body: JSON.stringify(data) };
    }
    
    // 3. Get Account Details
    if (action === 'get_account') {
        const sessionId = qs.session_id;
        if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: "Missing session_id" }) };
        
        const response = await fetch(`${TMDB_BASE_URL}/account?api_key=${apiKey}&session_id=${sessionId}`);
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
        body: JSON.stringify({ session_id: sessionId })
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
