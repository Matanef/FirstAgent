// server/tools/youtube.js
import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";

export async function youtube(query) {
  if (!CONFIG.YOUTUBE_API_KEY) {
    return {
      tool: "youtube",
      success: false,
      final: true,
      error: "YouTube API key not configured."
    };
  }

  try {
    const q = encodeURIComponent(query);
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${q}&key=${CONFIG.YOUTUBE_API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) {
      return {
        tool: "youtube",
        success: false,
        final: true,
        error: `YouTube API error: ${res.status}`
      };
    }

    const data = await res.json();

    const videos =
      data.items?.map(item => ({
        id: item.id?.videoId,
        title: item.snippet?.title,
        description: item.snippet?.description,
        channelTitle: item.snippet?.channelTitle,
        publishedAt: item.snippet?.publishedAt
      })) || [];

    return {
      tool: "youtube",
      success: true,
      final: true,
      data: {
        query,
        videos,
        raw: data
      }
    };
  } catch (err) {
    return {
      tool: "youtube",
      success: false,
      final: true,
      error: `YouTube tool failed: ${err.message}`
    };
  }
}