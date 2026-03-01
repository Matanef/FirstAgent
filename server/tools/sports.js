// server/tools/sports.js
// Full sports tool using API-Football v3 (api-sports.io)
// Supports: fixtures (upcoming/past), standings, live scores, top scorers

import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";

// ============================================================
// TEAM & LEAGUE MAPPINGS
// ============================================================

const TEAM_MAP = {
  // Premier League
  'arsenal': 42, 'chelsea': 49, 'liverpool': 40, 'man city': 50, 'manchester city': 50,
  'man united': 33, 'manchester united': 33, 'tottenham': 47, 'spurs': 47,
  'newcastle': 34, 'aston villa': 66, 'brighton': 51, 'west ham': 48,
  'crystal palace': 52, 'brentford': 55, 'fulham': 36, 'wolves': 39,
  'wolverhampton': 39, 'everton': 45, 'nottingham forest': 65, 'bournemouth': 35,
  'burnley': 44, 'luton': 1359, 'sheffield united': 62, 'ipswich': 57,
  'leicester': 46, 'southampton': 41,
  // La Liga
  'barcelona': 529, 'real madrid': 541, 'atletico madrid': 530, 'atletico': 530,
  'sevilla': 536, 'real sociedad': 548, 'villarreal': 533, 'betis': 543,
  // Serie A
  'ac milan': 489, 'milan': 489, 'inter': 505, 'inter milan': 505,
  'juventus': 496, 'napoli': 492, 'roma': 497, 'lazio': 487,
  // Bundesliga
  'bayern': 157, 'bayern munich': 157, 'dortmund': 165, 'borussia dortmund': 165,
  'leverkusen': 168, 'bayer leverkusen': 168, 'rb leipzig': 173, 'leipzig': 173,
  // Ligue 1
  'psg': 85, 'paris saint-germain': 85, 'marseille': 81, 'lyon': 80, 'monaco': 91,
};

const LEAGUE_MAP = {
  'premier league': 39, 'epl': 39, 'english premier league': 39,
  'la liga': 140, 'spanish league': 140,
  'serie a': 135, 'italian league': 135,
  'bundesliga': 78, 'german league': 78,
  'ligue 1': 61, 'french league': 61,
  'champions league': 2, 'ucl': 2,
  'europa league': 3, 'uel': 3,
  'world cup': 1, 'fifa world cup': 1,
  'euro': 4, 'european championship': 4,
};

// Default league if none specified
const DEFAULT_LEAGUE = 39; // Premier League
const CURRENT_SEASON = new Date().getFullYear();

// ============================================================
// API HELPERS
// ============================================================

async function apiRequest(endpoint, params = {}) {
  if (!CONFIG.SPORTS_API_KEY) {
    throw new Error("Sports API key not configured. Set SPORTS_API_KEY in your environment.");
  }

  const url = new URL(`https://v3.football.api-sports.io${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const res = await fetch(url.toString(), {
    headers: { "x-apisports-key": CONFIG.SPORTS_API_KEY }
  });

  if (!res.ok) {
    throw new Error(`API-Football error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Football: ${JSON.stringify(data.errors)}`);
  }

  return data.response || [];
}

// ============================================================
// INTENT DETECTION
// ============================================================

function detectIntent(query) {
  const lower = query.toLowerCase();

  // Extract team name
  let teamId = null;
  let teamName = null;
  for (const [name, id] of Object.entries(TEAM_MAP)) {
    if (lower.includes(name)) {
      teamId = id;
      teamName = name;
      break;
    }
  }

  // Extract league
  let leagueId = null;
  let leagueName = null;
  for (const [name, id] of Object.entries(LEAGUE_MAP)) {
    if (lower.includes(name)) {
      leagueId = id;
      leagueName = name;
      break;
    }
  }

  // If team found but no league, try to infer league from team
  if (teamId && !leagueId) {
    // Most common teams and their leagues
    if (teamId <= 66 || [1359, 57, 41, 62].includes(teamId)) leagueId = 39; // PL
    else if ([529, 541, 530, 536, 548, 533, 543].includes(teamId)) leagueId = 140; // La Liga
    else if ([489, 505, 496, 492, 497, 487].includes(teamId)) leagueId = 135; // Serie A
    else if ([157, 165, 168, 173].includes(teamId)) leagueId = 78; // Bundesliga
    else if ([85, 81, 80, 91].includes(teamId)) leagueId = 61; // Ligue 1
  }

  // Detect action
  let action = "fixtures"; // default

  if (/\b(live|right now|currently|ongoing|in progress)\b/i.test(lower)) {
    action = "live";
  } else if (/\b(standings?|table|league\s+table|rankings?|position|points)\b/i.test(lower)) {
    action = "standings";
  } else if (/\b(top\s+scor|goal\s+scor|leading\s+scor|golden\s+boot)\b/i.test(lower)) {
    action = "scorers";
  } else if (/\b(results?|last|previous|past|recent|score|won|lost|drew|beat)\b/i.test(lower)) {
    action = "results";
  } else if (/\b(next|upcoming|when|fixture|schedule|play\s+next|playing)\b/i.test(lower)) {
    action = "fixtures";
  }

  return {
    action,
    teamId,
    teamName,
    leagueId: leagueId || DEFAULT_LEAGUE,
    leagueName: leagueName || "Premier League"
  };
}

// ============================================================
// ACTION HANDLERS
// ============================================================

async function getFixtures(teamId, leagueId, count = 5) {
  const params = { next: count };
  if (teamId) params.team = teamId;
  else { params.league = leagueId; params.season = CURRENT_SEASON; }
  return apiRequest("/fixtures", params);
}

async function getResults(teamId, leagueId, count = 5) {
  const params = { last: count };
  if (teamId) params.team = teamId;
  else { params.league = leagueId; params.season = CURRENT_SEASON; }
  return apiRequest("/fixtures", params);
}

async function getLiveScores(leagueId) {
  return apiRequest("/fixtures", { live: "all", league: leagueId });
}

async function getStandings(leagueId, season) {
  const data = await apiRequest("/standings", {
    league: leagueId,
    season: season || CURRENT_SEASON
  });
  // API returns nested: [{ league: { standings: [[...teams]] } }]
  return data?.[0]?.league?.standings?.[0] || [];
}

async function getTopScorers(leagueId, season) {
  return apiRequest("/players/topscorers", {
    league: leagueId,
    season: season || CURRENT_SEASON
  });
}

// ============================================================
// FORMATTERS (pre-formatted markdown tables)
// ============================================================

function formatFixtures(fixtures, label = "Upcoming Fixtures") {
  if (!fixtures || fixtures.length === 0) {
    return `No ${label.toLowerCase()} found.`;
  }

  let text = `### ${label}\n\n`;
  text += "| Date | Home | vs | Away | Competition |\n";
  text += "|------|------|:--:|------|-------------|\n";

  for (const f of fixtures) {
    const date = new Date(f.fixture.date).toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
    const home = f.teams.home.name;
    const away = f.teams.away.name;
    const comp = f.league.name;
    text += `| ${date} | ${home} | vs | ${away} | ${comp} |\n`;
  }

  return text;
}

function formatResults(results, label = "Recent Results") {
  if (!results || results.length === 0) {
    return `No ${label.toLowerCase()} found.`;
  }

  let text = `### ${label}\n\n`;
  text += "| Date | Home | Score | Away | Competition |\n";
  text += "|------|------|:-----:|------|-------------|\n";

  for (const r of results) {
    const date = new Date(r.fixture.date).toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short"
    });
    const home = r.teams.home.name;
    const away = r.teams.away.name;
    const hGoals = r.goals.home ?? "?";
    const aGoals = r.goals.away ?? "?";
    const winner = r.teams.home.winner ? "**" : "";
    const winnerA = r.teams.away.winner ? "**" : "";
    const comp = r.league.name;
    text += `| ${date} | ${winner}${home}${winner} | ${hGoals} - ${aGoals} | ${winnerA}${away}${winnerA} | ${comp} |\n`;
  }

  return text;
}

function formatStandings(standings, leagueName) {
  if (!standings || standings.length === 0) {
    return `No standings data found for ${leagueName}.`;
  }

  let text = `### ${leagueName} Standings\n\n`;
  text += "| # | Team | P | W | D | L | GF | GA | GD | Pts |\n";
  text += "|--:|------|--:|--:|--:|--:|---:|---:|---:|----:|\n";

  for (const t of standings) {
    text += `| ${t.rank} | ${t.team.name} | ${t.all.played} | ${t.all.win} | ${t.all.draw} | ${t.all.lose} | ${t.all.goals.for} | ${t.all.goals.against} | ${t.goalsDiff} | **${t.points}** |\n`;
  }

  return text;
}

function formatLiveScores(matches, leagueName) {
  if (!matches || matches.length === 0) {
    return `No live matches right now${leagueName ? ` in ${leagueName}` : ""}.`;
  }

  let text = `### Live Scores${leagueName ? ` - ${leagueName}` : ""}\n\n`;
  text += "| Status | Home | Score | Away | Minute |\n";
  text += "|--------|------|:-----:|------|-------:|\n";

  for (const m of matches) {
    const status = m.fixture.status.short;
    const minute = m.fixture.status.elapsed || "-";
    text += `| ${status} | ${m.teams.home.name} | ${m.goals.home ?? 0} - ${m.goals.away ?? 0} | ${m.teams.away.name} | ${minute}' |\n`;
  }

  return text;
}

function formatTopScorers(scorers, leagueName) {
  if (!scorers || scorers.length === 0) {
    return `No top scorer data found for ${leagueName}.`;
  }

  let text = `### Top Scorers - ${leagueName}\n\n`;
  text += "| # | Player | Team | Goals | Assists | Apps |\n";
  text += "|--:|--------|------|------:|--------:|-----:|\n";

  scorers.slice(0, 20).forEach((s, i) => {
    const p = s.player;
    const stats = s.statistics?.[0];
    text += `| ${i + 1} | ${p.name} | ${stats?.team?.name || "?"} | ${stats?.goals?.total || 0} | ${stats?.goals?.assists || 0} | ${stats?.games?.appearences || 0} |\n`;
  });

  return text;
}

// ============================================================
// MAIN EXPORT
// ============================================================

export async function sports(query) {
  if (!CONFIG.SPORTS_API_KEY) {
    return {
      tool: "sports",
      success: false,
      final: true,
      error: "Sports API key not configured. Set SPORTS_API_KEY in your environment."
    };
  }

  try {
    const intent = detectIntent(query);
    console.log(`[sports] Intent: ${intent.action}, team: ${intent.teamName || "none"}, league: ${intent.leagueName}`);

    let text = "";
    let rawData = null;

    switch (intent.action) {
      case "fixtures": {
        const data = await getFixtures(intent.teamId, intent.leagueId);
        rawData = data;
        const label = intent.teamName
          ? `Upcoming ${intent.teamName.charAt(0).toUpperCase() + intent.teamName.slice(1)} Fixtures`
          : `Upcoming ${intent.leagueName} Fixtures`;
        text = formatFixtures(data, label);
        break;
      }

      case "results": {
        const data = await getResults(intent.teamId, intent.leagueId);
        rawData = data;
        const label = intent.teamName
          ? `Recent ${intent.teamName.charAt(0).toUpperCase() + intent.teamName.slice(1)} Results`
          : `Recent ${intent.leagueName} Results`;
        text = formatResults(data, label);
        break;
      }

      case "standings": {
        const data = await getStandings(intent.leagueId);
        rawData = data;
        text = formatStandings(data, intent.leagueName);
        break;
      }

      case "live": {
        const data = await getLiveScores(intent.leagueId);
        rawData = data;
        text = formatLiveScores(data, intent.leagueName);
        break;
      }

      case "scorers": {
        const data = await getTopScorers(intent.leagueId);
        rawData = data;
        text = formatTopScorers(data, intent.leagueName);
        break;
      }

      default: {
        const data = await getFixtures(intent.teamId, intent.leagueId);
        rawData = data;
        text = formatFixtures(data, "Fixtures");
      }
    }

    return {
      tool: "sports",
      success: true,
      final: true,
      data: {
        type: intent.action,
        team: intent.teamName,
        league: intent.leagueName,
        text,
        preformatted: true, // Signal to executor to skip LLM summarization
        items: rawData
      }
    };

  } catch (err) {
    console.error("[sports] Error:", err.message);
    return {
      tool: "sports",
      success: false,
      final: true,
      error: `Sports tool failed: ${err.message}`
    };
  }
}
