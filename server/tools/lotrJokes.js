// server/tools/lotrJokes.js
// LOTR Jokes Automation - Scheduled jokes delivery

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JOKES_FILE = path.resolve(__dirname, "../data/lotr-jokes.json");

let jokesData = null;
let lastUsedIndices = {
  gandalf: -1,
  frodo: -1,
  sam: -1,
  aragorn: -1,
  legolas: -1,
  gimli: -1,
  gollum: -1,
  saruman: -1,
  misc: -1
};

async function loadJokes() {
  if (jokesData) return jokesData;

  try {
    const data = await fs.readFile(JOKES_FILE, "utf8");
    jokesData = JSON.parse(data);
    return jokesData;
  } catch (err) {
    console.error("Failed to load LOTR jokes:", err);
    return null;
  }
}

function getRandomJoke(character = null) {
  if (!jokesData) return null;

  // If character specified, get from that category
  if (character && jokesData.jokes[character]) {
    const jokes = jokesData.jokes[character];
    // Get next joke (sequential with wrap-around to avoid repeats)
    lastUsedIndices[character] = (lastUsedIndices[character] + 1) % jokes.length;
    let index = lastUsedIndices[character];

    return {
      joke: jokes[index],
      character: character.charAt(0).toUpperCase() + character.slice(1),
      source: "LOTR Jokes Database"
    };
  }

  // Random character
  const characters = Object.keys(jokesData.jokes);
  const randomChar = characters[Math.floor(Math.random() * characters.length)];
  return getRandomJoke(randomChar);
}

function parseCharacter(query) {
  const lower = query.toLowerCase();

  // Primary characters (direct keys in JSON)
  const primaries = ["gandalf", "frodo", "sam", "aragorn", "legolas", "gimli", "gollum", "saruman"];
  for (const char of primaries) {
    if (lower.includes(char)) return char;
  }

  // Map other characters to closest category or misc
  if (lower.includes("bilbo") || lower.includes("merry") || lower.includes("pippin")) return "frodo";
  if (lower.includes("samwise")) return "sam";
  if (lower.includes("strider") || lower.includes("boromir")) return "aragorn";
  if (lower.includes("smeagol")) return "gollum";
  if (lower.includes("mithrandir") || lower.includes("wizard")) return "gandalf";
  if (lower.includes("dwarf")) return "gimli";
  if (lower.includes("elf")) return "legolas";

  // Specific misc categories
  const miscTerms = ["hobbit", "orc", "ent", "nazgul", "ring", "rohan", "sauron", "balrog", "mordor", "doom", "fellowship"];
  if (miscTerms.some(term => lower.includes(term))) {
    return "misc";
  }

  return null;
}

async function saveSchedule(schedule) {
  if (!jokesData) await loadJokes();
  jokesData.scheduledMessages = schedule;
  await fs.writeFile(JOKES_FILE, JSON.stringify(jokesData, null, 2), "utf8");
}

export async function lotrJokes(query) {
  try {
    await loadJokes();

    if (!jokesData) {
      return {
        tool: "lotrJokes",
        success: false,
        final: true,
        error: "LOTR jokes database not found. Please check server/data/lotr-jokes.json"
      };
    }

    const lower = query.toLowerCase();

    // Handle scheduling requests
    if (lower.includes("schedule") || lower.includes("every day") || lower.includes("every monday")) {
      const timeMatch = lower.match(/at\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
      const time = timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2] || '00'}` : "09:00";

      const schedule = { ...jokesData.scheduledMessages };

      if (lower.includes("every day") || lower.includes("daily")) {
        schedule.daily.enabled = true;
        schedule.daily.time = time;

        await saveSchedule(schedule);

        return {
          tool: "lotrJokes",
          success: true,
          final: true,
          data: {
            message: `✅ Scheduled daily LOTR jokes at ${time}\n\n⚠️ Note: Scheduling system requires a cron job to be set up. This has been saved to configuration.`,
            schedule: schedule.daily
          }
        };
      } else if (lower.includes("every monday") || lower.includes("weekly")) {
        schedule.weekly.enabled = true;
        schedule.weekly.time = time;

        await saveSchedule(schedule);

        return {
          tool: "lotrJokes",
          success: true,
          final: true,
          data: {
            message: `✅ Scheduled weekly LOTR jokes (Monday) at ${time}\n\n⚠️ Note: Scheduling system requires a cron job to be set up. This has been saved to configuration.`,
            schedule: schedule.weekly
          }
        };
      }
    }

    // Handle "tell me a joke" requests
    const character = parseCharacter(query);
    const joke = getRandomJoke(character);

    if (!joke) {
      return {
        tool: "lotrJokes",
        success: false,
        final: true,
        error: "Could not generate a joke. Please try again!"
      };
    }

    return {
      tool: "lotrJokes",
      success: true,
      final: true,
      data: {
        joke: joke.joke,
        character: joke.character,
        html: `
          <div class="lotr-joke">
            <div class="joke-header">
              <span class="joke-icon">🎭</span>
              <span class="joke-character">${joke.character}</span>
            </div>
            <div class="joke-content">${joke.joke}</div>
            <div class="joke-footer">
              <span>LOTR Jokes Database</span>
              <span>${jokesData.meta.totalJokes} jokes available</span>
            </div>
          </div>
          
          <style>
            .lotr-joke {
              background: var(--bg-tertiary);
              border: 2px solid var(--accent);
              border-radius: 12px;
              padding: 1.5rem;
              margin: 1rem 0;
              max-width: 600px;
            }
            .joke-header {
              display: flex;
              align-items: center;
              gap: 0.75rem;
              margin-bottom: 1rem;
              padding-bottom: 0.75rem;
              border-bottom: 1px solid var(--border);
            }
            .joke-icon {
              font-size: 2rem;
            }
            .joke-character {
              font-size: 1.25rem;
              font-weight: 700;
              color: var(--accent);
            }
            .joke-content {
              font-size: 1.1rem;
              line-height: 1.6;
              color: var(--text-primary);
              margin: 1rem 0;
            }
            .joke-footer {
              display: flex;
              justify-content: space-between;
              margin-top: 1rem;
              padding-top: 0.75rem;
              border-top: 1px solid var(--border);
              font-size: 0.85rem;
              color: var(--text-muted);
            }
          </style>
        `,
        text: `${joke.character} says: ${joke.joke}`
      }
    };

  } catch (err) {
    console.error("LOTR jokes error:", err);
    return {
      tool: "lotrJokes",
      success: false,
      final: true,
      error: `Failed to get LOTR joke: ${err.message}`
    };
  }
}
