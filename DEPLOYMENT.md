# Deployment Instructions for Netlify

To deploy this application to Netlify and ensure authentication works correctly, follow these steps:

## 1. Push to Netlify

Push your code to your GitHub repository connected to Netlify.

## 2. Configure Environment Variables

In your Netlify Site Settings > Build & deploy > Environment variables, add the following variables:

- `OPENAI_API_KEY`: Your OpenAI API Key.
- `ASTRA_DB_APPLICATION_TOKEN`: Your Astra DB Application Token.
- `ASTRA_DB_API_ENDPOINT`: Your Astra DB API Endpoint.
- `TMDB_API_KEY`: Your TMDB API Key.

## 3. Configure Auth0

In your Auth0 Dashboard for the application `dev-m8rlho4hfnlmqtte.us.auth0.com` (Client ID: `GYLpbuiXYNt8n3AsLLjrWOIJjAyLWGPB`):

1.  Go to **Settings** > **Application URIs**.
2.  Add `https://theintersect.netlify.app` to **Allowed Callback URLs**.
3.  Add `https://theintersect.netlify.app` to **Allowed Logout URLs**.
4.  Add `https://theintersect.netlify.app` to **Allowed Web Origins**.
5.  Save Changes.

## 4. Verify Deployment

Visit `https://theintersect.netlify.app`.
- Click "Login".
- You should be redirected to Auth0.
- After login, you should be redirected back to `https://theintersect.netlify.app` and see your user profile.

## Notes

- The application is configured to redirect to `https://theintersect.netlify.app` upon login.
- Ensure that your Netlify site name is indeed `theintersect`. If it is different, update the `redirect_uri` in `main.js` (line ~40) to match your actual Netlify URL.
- Do not commit your `.env` file to GitHub. It is already in `.gitignore`.
