// server/tools/sports.js
// Sports tool using API-Football: fixtures, scores, standings, team search
import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";

const API_BASE = "https://v3.football.api-sports.io";

/**
 * League name -> API-Football league ID mapping
 */
const LEAGUE_MAP = {
  "premier league": 39,
  "epl": 39,
  "english premier league": 39,
  "la liga": 140,
  "laliga": 140,
  "serie a": 135,
  "bundesliga": 78,
  "ligue 1": 61,
  "champions league": 2,
  "ucl": 2,
  "europa league": 3,
  "world cup": 1,
  "euro": 4,
  "mls": 253,
  "israeli premier league": 382,
  "ligat ha'al": 382,
  "eredivisie": 88,
  "primeira liga": 94,
  "liga portugal": 94,
  "super lig": 203,
  "saudi pro league": 307
};

/**
 * Common team aliases
 */
const TEAM_ALIASES = {
  "barca": "barcelona",
  "real": "real madrid",
  "man utd": "manchester united",
  "man u": "manchester united",
  "man city": "manchester city",
  "spurs": "tottenham",
  "bayern": "bayern munich",
  "psg": "paris saint germain",
  "juve": "juventus",
  "inter": "inter milan",
  "atletico": "atletico madrid",
  "dortmund": "borussia dortmund",
  "bvb": "borussia dortmund"
};

/**
 * Make authenticated API-Football request
 */
async function apiFetch(endpoint, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url = `${API_BASE}/${endpoint}${query ? "?" + query : ""}`;

  const res = await fetch(url, {
    headers: { "x-apisports-key": CONFIG.SPORTS_API_KEY }
  });

  if (!res.ok) {
    throw new Error(`API-Football error: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Get current season year
 */
function getCurrentSeason() {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

/**
 * Detect league from query text
 */
function detectLeague(text) {
  const lower = text.toLowerCase();
  for (const [name, id] of Object.entries(LEAGUE_MAP)) {
    if (lower.includes(name)) return { name, id };
  }
  return null;
}

/**
 * Detect team name from query text
 */
function detectTeam(text) {
  const lower = text.toLowerCase();
  for (const [alias, fullName] of Object.entries(TEAM_ALIASES)) {
    if (lower.includes(alias)) return fullName;
  }
  const teamMatch = text.match(/(?:for|about|of)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
  if (teamMatch) return teamMatch[1].toLowerCase();
  return null;
}

/**
 * Detect query intent
 */
function detectIntent(text) {
  const lower = text.toLowerCase();

  if (/\b(standing|table|rank|position|league\s+table)\b/.test(lower)) return "standings";
  if (/\b(live|ongoing|current|happening\s+now|in\s+progress)\b/.test(lower)) return "live";
  if (/\b(today|tonight|match\s+today|game\s+today|playing\s+today)\b/.test(lower)) return "today";
  if (/\b(tomorrow|upcoming|next\s+match|next\s+game|fixtures?|schedule)\b/.test(lower)) return "fixtures";
  if (/\b(yesterday|last\s+match|last\s+game|recent\s+results?|results?|scores?)\b/.test(lower)) return "results";
  if (/\b(top\s+scorer|goals?|assist|stats)\b/.test(lower)) return "topscorers";

  return "today";
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

function formatFixture(f) {
  const home = f.teams.home.name;
  const away = f.teams.away.name;
  const homeGoals = f.goals.home;
  const awayGoals = f.goals.away;
  const status = f.fixture.status.short;
  const date = new Date(f.fixture.date);
  const timeStr = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const dateStr = date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  if (status === "FT" || status === "AET" || status === "PEN") {
    return `${home} ${homeGoals} - ${awayGoals} ${away} (${status})`;
  }
  if (status === "1H" || status === "2H" || status === "HT" || status === "ET" || status === "LIVE") {
    return `${home} ${homeGoals ?? 0} - ${awayGoals ?? 0} ${away} (LIVE - ${f.fixture.status.elapsed}')`;
  }
  if (status === "NS") {
    return `${home} vs ${away} -- ${dateStr} at ${timeStr}`;
  }
  return `${home} vs ${away} -- ${status}`;
}

// ──────────────────────────────────────────────────────────
// HANDLERS
// ──────────────────────────────────────────────────────────

async function getStandings(leagueId, season) {
  const data = await apiFetch("standings", { league: leagueId, season });
  const standings = data?.response?.[0]?.league?.standings?.[0];

  if (!standings || standings.length === 0) {
    return { success: false, error: "No standings data available for this league/season." };
  }

  const leagueName = data.response[0].league.name;
  const rows = standings.map(t => ({
    rank: t.rank,
    team: t.team.name,
    played: t.all.played,
    won: t.all.win,
    drawn: t.all.draw,
    lost: t.all.lose,
    gf: t.all.goals.for,
    ga: t.all.goals.against,
    gd: t.goalsDiff,
    points: t.points
  }));

  const table = rows.map(r =>
    `${String(r.rank).padStart(2)}. ${r.team.padEnd(25)} ${String(r.played).padStart(2)}  ${String(r.won).padStart(2)}W ${String(r.drawn).padStart(2)}D ${String(r.lost).padStart(2)}L  ${String(r.gf).padStart(2)}-${String(r.ga).padStart(2)}  ${String(r.points).padStart(2)}pts`
  ).join("\n");

  return {
    success: true,
    data: {
      league: leagueName,
      season,
      standings: rows,
      preformatted: true,
      text: `**${leagueName} Standings (${season}/${season + 1})**\n\n\`\`\`\n${table}\n\`\`\``
    }
  };
}

async function getFixtures(leagueId, date, label) {
  const params = { date };
  if (leagueId) {
    params.league = leagueId;
    params.season = getCurrentSeason();
  }

  const data = await apiFetch("fixtures", params);
  const fixtures = data?.response || [];

  if (fixtures.length === 0) {
    return {
      success: true,
      data: { preformatted: true, text: `No matches found for ${label}.` }
    };
  }

  // Group by league
  const byLeague = {};
  for (const f of fixtures) {
    const league = f.league.name;
    if (!byLeague[league]) byLeague[league] = [];
    byLeague[league].push(f);
  }

  let text = `**Matches -- ${label}**\n\n`;
  for (const [league, matches] of Object.entries(byLeague)) {
    text += `**${league}:**\n`;
    for (const f of matches) {
      text += `  ${formatFixture(f)}\n`;
    }
    text += "\n";
  }

  return {
    success: true,
    data: {
      fixtures: fixtures.map(f => ({
        home: f.teams.home.name,
        away: f.teams.away.name,
        homeGoals: f.goals.home,
        awayGoals: f.goals.away,
        status: f.fixture.status.short,
        date: f.fixture.date,
        league: f.league.name
      })),
      preformatted: true,
      text: text.trim()
    }
  };
}

async function getLiveMatches() {
  const data = await apiFetch("fixtures", { live: "all" });
  const fixtures = data?.response || [];

  if (fixtures.length === 0) {
    return {
      success: true,
      data: { preformatted: true, text: "No live matches right now." }
    };
  }

  const byLeague = {};
  for (const f of fixtures) {
    const league = f.league.name;
    if (!byLeague[league]) byLeague[league] = [];
    byLeague[league].push(f);
  }

  let text = `**Live Matches (${fixtures.length} ongoing)**\n\n`;
  for (const [league, matches] of Object.entries(byLeague)) {
    text += `**${league}:**\n`;
    for (const f of matches) {
      text += `  ${formatFixture(f)}\n`;
    }
    text += "\n";
  }

  return {
    success: true,
    data: {
      fixtures: fixtures.map(f => ({
        home: f.teams.home.name,
        away: f.teams.away.name,
        homeGoals: f.goals.home,
        awayGoals: f.goals.away,
        elapsed: f.fixture.status.elapsed,
        league: f.league.name
      })),
      preformatted: true,
      text: text.trim()
    }
  };
}

async function getTopScorers(leagueId, season) {
  const data = await apiFetch("players/topscorers", { league: leagueId, season });
  const players = data?.response || [];

  if (players.length === 0) {
    return { success: false, error: "No top scorer data available." };
  }

  const leagueName = players[0]?.statistics?.[0]?.league?.name || "League";
  const rows = players.slice(0, 15).map((p, i) => ({
    rank: i + 1,
    name: p.player.name,
    team: p.statistics[0]?.team?.name || "N/A",
    goals: p.statistics[0]?.goals?.total || 0,
    assists: p.statistics[0]?.goals?.assists || 0,
    appearances: p.statistics[0]?.games?.appearences || 0
  }));

  const text = `**${leagueName} Top Scorers (${season}/${season + 1})**\n\n` +
    rows.map(r => `${r.rank}. **${r.name}** (${r.team}) -- ${r.goals} goals, ${r.assists} assists (${r.appearances} apps)`).join("\n");

  return {
    success: true,
    data: { players: rows, preformatted: true, text }
  };
}

async function searchTeam(teamName) {
  const data = await apiFetch("teams", { search: teamName });
  const teams = data?.response || [];

  if (teams.length === 0) {
    return { success: false, error: `No team found matching "${teamName}".` };
  }

  const team = teams[0].team;
  const venue = teams[0].venue;

  // Fetch next 5 fixtures for this team
  const fixturesData = await apiFetch("fixtures", {
    team: team.id,
    next: 5,
    season: getCurrentSeason()
  });
  const nextFixtures = fixturesData?.response || [];

  let text = `**${team.name}**\n`;
  text += `Country: ${team.country}\n`;
  text += `Founded: ${team.founded || "N/A"}\n`;
  if (venue) text += `Stadium: ${venue.name} (${venue.city}, capacity ${venue.capacity})\n`;

  if (nextFixtures.length > 0) {
    text += `\n**Upcoming Matches:**\n`;
    for (const f of nextFixtures) {
      text += `  ${formatFixture(f)}\n`;
    }
  }

  return {
    success: true,
    data: {
      team: { id: team.id, name: team.name, country: team.country, founded: team.founded },
      venue: venue ? { name: venue.name, city: venue.city, capacity: venue.capacity } : null,
      nextFixtures: nextFixtures.map(f => ({
        home: f.teams.home.name,
        away: f.teams.away.name,
        date: f.fixture.date,
        league: f.league.name
      })),
      preformatted: true,
      text
    }
  };
}

// ──────────────────────────────────────────────────────────
// MAIN SPORTS TOOL
// ──────────────────────────────────────────────────────────

export async function sports(query) {
  if (!CONFIG.SPORTS_API_KEY) {
    return {
      tool: "sports",
      success: false,
      final: true,
      error: "Sports API key not configured. Set SPORTS_API_KEY in your .env file."
    };
  }

  const text = typeof query === "string" ? query : (query?.text || query?.input || "");

  try {
    const intent = detectIntent(text);
    const league = detectLeague(text);
    const team = detectTeam(text);
    const season = getCurrentSeason();

    console.log(`[sports] Intent: ${intent}, League: ${league?.name || "none"}, Team: ${team || "none"}`);

    let result;

    switch (intent) {
      case "standings": {
        const leagueId = league?.id || 39;
        result = await getStandings(leagueId, season);
        break;
      }
      case "live": {
        result = await getLiveMatches();
        break;
      }
      case "today": {
        const today = formatDate(new Date());
        result = await getFixtures(league?.id || null, today, "Today");
        break;
      }
      case "fixtures": {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        result = await getFixtures(league?.id || null, formatDate(tomorrow), "Upcoming");
        break;
      }
      case "results": {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        result = await getFixtures(league?.id || null, formatDate(yesterday), "Yesterday's Results");
        break;
      }
      case "topscorers": {
        const leagueId = league?.id || 39;
        result = await getTopScorers(leagueId, season);
        break;
      }
      default: {
        if (team) {
          result = await searchTeam(team);
        } else {
          const today = formatDate(new Date());
          result = await getFixtures(league?.id || null, today, "Today");
        }
      }
    }

    if (!result.success && result.error) {
      return { tool: "sports", success: false, final: true, error: result.error };
    }

    return { tool: "sports", success: true, final: true, data: result.data };

  } catch (err) {
    console.error("[sports] Error:", err);
    return {
      tool: "sports",
      success: false,
      final: true,
      error: `Sports data unavailable: ${err.message}`
    };
  }
}
