// server/tools/spotify.js
// A fully functional Spotify controller using the Spotify Web API and OAuth2 refresh token flow.

import { CONFIG } from "../utils/config.js";
import fetch from "node-fetch";

/**
 * A fully functional Spotify controller using the Spotify Web API and OAuth2 refresh token flow.
 * @param {string|object} request - User input (string or {text, context})
 * @returns {object} Standard tool response
 */
export async function spotifyController(request) {
  try {
    const text = typeof request === "string" ? request : (request?.text || "");
    const context = typeof request === "object" ? (request?.context || {}) : {};

    // Extract command and query from the input
    const words = text.toLowerCase().split(' ').filter(Boolean);
    const command = words[0];
    const query = words.slice(1).join(' '); // Grab the rest of the sentence as the search query

    if (!CONFIG.SPOTIFY_ACCESS_TOKEN) {
      await refreshAccessToken();
    }

    let response;
    switch (command) {
      case "play":
        if (query) {
          response = await searchAndPlay(query);
        } else {
          response = await playCurrentTrack();
        }
        break;
      case "pause":
        response = await pauseTrack();
        break;
      case "skip":
      case "next":
        response = await skipToNextTrack();
        break;
      case "previous":
      case "back":
        response = await goBackToPreviousTrack();
        break;
      default:
        return {
          tool: "spotifyController",
          success: false,
          final: true,
          error: "Invalid command. Use 'play', 'pause', 'skip', or 'previous'."
        };
    }

    return {
      tool: "spotifyController",
      success: true,
      final: true,
      data: response
    };
  } catch (err) {
    console.error("[spotifyController] Error:", err.message);
    return {
      tool: "spotifyController",
      success: false,
      final: true,
      error: err.message
    };
  }
}

/**
 * Helper to get Base64 encoded client credentials for Spotify API.
 * @returns {string}
 */
function getClientCredentials() {
  if (!CONFIG.SPOTIFY_CLIENT_ID || !CONFIG.SPOTIFY_CLIENT_SECRET) {
    throw new Error("Spotify client ID and client secret are not configured in CONFIG.");
  }
  const credentials = `${CONFIG.SPOTIFY_CLIENT_ID}:${CONFIG.SPOTIFY_CLIENT_SECRET}`;
  return Buffer.from(credentials).toString('base64');
}

/**
 * Refreshes the Spotify access token using the refresh token.
 */
async function refreshAccessToken() {
  const url = "https://accounts.spotify.com/api/token";
  const authHeader = `Basic ${getClientCredentials()}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": authHeader 
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: CONFIG.SPOTIFY_REFRESH_TOKEN
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to refresh access token: ${response.status} - ${errorBody}`);
  }

  const data = await response.json();
  CONFIG.SPOTIFY_ACCESS_TOKEN = data.access_token;
}

/**
 * Searches for a track and plays it on Spotify.
 * @param {string} query - The search query
 * @returns {object} The search results or an error message
 */
async function searchAndPlay(query) {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track`;
  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${CONFIG.SPOTIFY_ACCESS_TOKEN}`
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to search for track: ${response.status} - ${errorBody}`);
  }

  const data = await response.json();
  const tracks = data.tracks.items;
  if (tracks.length === 0) {
    return { text: "No results found.", preformatted: true };
  }

  const trackUri = tracks[0].uri;
  const playUrl = `https://api.spotify.com/v1/me/player/play`;
  const playResponse = await fetch(playUrl, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${CONFIG.SPOTIFY_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ uris: [trackUri] })
  });

  if (!playResponse.ok) {
    const errorBody = await playResponse.text();
    throw new Error(`Failed to play track: ${playResponse.status} - ${errorBody}`);
  }

  return { text: `▶️ Playing "${tracks[0].name}" by ${tracks[0].artists.map(a => a.name).join(", ")}`, preformatted: true };
}

/**
 * Plays the current track on Spotify (resumes playback).
 * @returns {object} A success message
 */
async function playCurrentTrack() {
  const url = "https://api.spotify.com/v1/me/player/play";
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${CONFIG.SPOTIFY_ACCESS_TOKEN}`,
      "Content-Type": "application/json" 
    }
  });

  if (!response.ok && response.status !== 204) {
    const errorBody = await response.text();
    throw new Error(`Failed to play current track: ${response.status} - ${errorBody}`);
  }

  return { text: "▶️ Resumed playback.", preformatted: true };
}

/**
 * Pauses the current track on Spotify.
 * @returns {object} A success message
 */
async function pauseTrack() {
  const url = "https://api.spotify.com/v1/me/player/pause";
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${CONFIG.SPOTIFY_ACCESS_TOKEN}`
    }
  });

  if (!response.ok && response.status !== 204) {
    const errorBody = await response.text();
    throw new Error(`Failed to pause track: ${response.status} - ${errorBody}`);
  }

  return { text: "⏸️ Track paused.", preformatted: true };
}

/**
 * Skips to the next track on Spotify.
 * @returns {object} A success message
 */
async function skipToNextTrack() {
  const url = "https://api.spotify.com/v1/me/player/next";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CONFIG.SPOTIFY_ACCESS_TOKEN}`
    }
  });

  if (!response.ok && response.status !== 204) {
    const errorBody = await response.text();
    throw new Error(`Failed to skip to next track: ${response.status} - ${errorBody}`);
  }

  return { text: "⏭️ Skipped to the next track.", preformatted: true };
}

/**
 * Goes back to the previous track on Spotify.
 * @returns {object} A success message
 */
async function goBackToPreviousTrack() {
  const url = "https://api.spotify.com/v1/me/player/previous";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CONFIG.SPOTIFY_ACCESS_TOKEN}`
    }
  });

  if (!response.ok && response.status !== 204) {
    const errorBody = await response.text();
    throw new Error(`Failed to go back to previous track: ${response.status} - ${errorBody}`);
  }

  return { text: "⏮️ Going back to the previous track.", preformatted: true };
}