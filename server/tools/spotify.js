// server/tools/spotify.js
export async function spotify(query) {
  return {
    tool: "spotify",
    success: false,
    final: true,
    error: "Spotify integration not configured. Get API key from https://developer.spotify.com/dashboard"
  };
}

// Setup guide:
// 1. Go to https://developer.spotify.com/dashboard
// 2. Create app
// 3. Get Client ID and Client Secret
// 4. Add to .env:
//    SPOTIFY_CLIENT_ID=xxx
//    SPOTIFY_CLIENT_SECRET=xxx