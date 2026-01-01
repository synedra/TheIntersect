import fetch from 'node-fetch';

export async function handler(event) {
  const qs = event.queryStringParameters || {}
  const path = qs.path

  if (!path) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing required query param: path" }),
      headers: { "Content-Type": "application/json" }
    }
  }

  const apiKey = process.env.TMDB_API_KEY
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "TMDB_API_KEY is not set" }),
      headers: { "Content-Type": "application/json" }
    }
  }

  // Build TMDB query params from everything EXCEPT `path`
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(qs)) {
    if (k === "path") continue
    if (v != null && v !== "") params.set(k, v)
  }
  params.set("api_key", apiKey)

  const tmdbUrl = `https://api.themoviedb.org/3/${path}?${params.toString()}`

  try {
    const res = await fetch(tmdbUrl)
    const data = await res.json()

    return {
      statusCode: res.status,
      body: JSON.stringify(data),
      headers: { "Content-Type": "application/json" }
    }
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err?.message || String(err) }),
      headers: { "Content-Type": "application/json" }
    }
  }
}

