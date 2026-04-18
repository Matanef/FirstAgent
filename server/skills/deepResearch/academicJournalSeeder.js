// server/skills/deepResearch/academicJournalSeeder.js
// One-time seeder for 38 FT50 academic journal RSS feeds.
//
// Each feed is assigned to a subject slug with appropriate keywords so the
// subjectMatcher can route relevant research queries to these sources.
//
// Run automatically on first deepResearch startup (flag: _meta.academicJournalsSeeded).
// Safe to call repeatedly — uses upsertSubject() which merges rather than overwrites.

import { upsertSubject, load, save } from "./sourceDirectory.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("academicJournalSeeder", { consoleLevel: "warn" });

// ── Subject definitions with their RSS feeds ──────────────────────────────────
//
// Each entry maps to one subject slug. `priority_sources` holds the actual RSS
// feed URLs — the articleHarvester detects https:// URLs and routes them to the
// RSS fetcher automatically.
//
// Journal list sourced from: https://github.com/yexner/rss-feeds-academic-journals
// (FT50 business & management journals)

const ACADEMIC_SUBJECTS = [

  // ── General Management & Organization ──────────────────────────────────────
  {
    slug: "academic_management",
    topic: "Management and Organization Theory",
    aliases: ["management research", "organization theory", "organizational science", "general management"],
    keywords: [
      "management", "organization", "organizational", "leadership", "corporate governance",
      "firm performance", "institutional theory", "managerial", "organizational behavior",
      "upper echelon", "executive", "boards of directors", "agency theory", "resource based view",
      "dynamic capabilities", "transaction cost", "organizational learning", "knowledge management"
    ],
    types: ["academic", "journal", "management"],
    priority_sources: [
      // Academy of Management
      "https://journals.aom.org/action/showFeed?type=etoc&feed=rss&jc=amj",  // AMJ
      "https://journals.aom.org/action/showFeed?type=etoc&feed=rss&jc=amr",  // AMR
      // SAGE
      "https://journals.sagepub.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=jomab",  // Journal of Management
      "https://journals.sagepub.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=asqa",   // Administrative Science Quarterly
      // Wiley
      "https://onlinelibrary.wiley.com/action/showFeed?jc=14676486&type=etoc&feed=rss",  // Journal of Management Studies
      // INFORMS
      "https://pubsonline.informs.org/action/showFeed?jc=orsc&type=etoc&feed=rss",   // Organization Science
      "https://pubsonline.informs.org/action/showFeed?jc=mnsc&type=etoc&feed=rss",   // Management Science
      // SAGE
      "https://journals.sagepub.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=ossa",   // Organization Studies
      "https://journals.sagepub.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=huma",   // Human Relations
    ]
  },

  // ── Strategy & Competitive Advantage ──────────────────────────────────────
  {
    slug: "academic_strategy",
    topic: "Strategic Management",
    aliases: ["competitive strategy", "business strategy", "corporate strategy", "strategic planning"],
    keywords: [
      "strategy", "strategic", "competitive advantage", "Porter", "VRIO", "resource based",
      "dynamic capabilities", "disruption", "industry analysis", "market positioning",
      "diversification", "vertical integration", "mergers acquisitions", "M&A", "alliance",
      "co-opetition", "value chain", "business model", "competitive dynamics"
    ],
    types: ["academic", "journal", "strategy"],
    priority_sources: [
      // Wiley
      "https://onlinelibrary.wiley.com/action/showFeed?jc=10970266&type=etoc&feed=rss",   // Strategic Management Journal
      "https://onlinelibrary.wiley.com/action/showFeed?jc=14676486&type=etoc&feed=rss",   // Journal of Management Studies
      // INFORMS
      "https://pubsonline.informs.org/action/showFeed?jc=orsc&type=etoc&feed=rss",        // Organization Science
      "https://pubsonline.informs.org/action/showFeed?jc=mnsc&type=etoc&feed=rss",        // Management Science
      // ScienceDirect
      "https://rss.sciencedirect.com/publication/science/00487333",                        // Research Policy
      // AOM
      "https://journals.aom.org/action/showFeed?type=etoc&feed=rss&jc=amj",
      "https://journals.aom.org/action/showFeed?type=etoc&feed=rss&jc=amr",
    ]
  },

  // ── Finance & Economics ────────────────────────────────────────────────────
  {
    slug: "academic_finance",
    topic: "Finance and Economics",
    aliases: ["financial economics", "corporate finance", "financial markets", "macroeconomics"],
    keywords: [
      "finance", "financial", "economics", "market", "capital structure", "equity", "debt",
      "asset pricing", "portfolio", "risk", "return", "stock market", "bond", "derivative",
      "hedge fund", "private equity", "venture capital", "IPO", "dividend", "corporate finance",
      "monetary policy", "fiscal policy", "GDP", "inflation", "macroeconomics", "microeconomics",
      "behavioral finance", "efficient market hypothesis", "valuation", "CAPM"
    ],
    types: ["academic", "journal", "finance", "economics"],
    priority_sources: [
      // Wiley
      "https://onlinelibrary.wiley.com/action/showFeed?jc=15406261&type=etoc&feed=rss",   // Journal of Finance
      "https://onlinelibrary.wiley.com/action/showFeed?jc=14680262&type=etoc&feed=rss",   // Econometrica
      // ScienceDirect
      "https://rss.sciencedirect.com/publication/science/0304405X",                        // Journal of Financial Economics
      // UChicago
      "https://www.journals.uchicago.edu/action/showFeed?jc=jpe&type=etoc&feed=rss",      // Journal of Political Economy
    ]
  },

  // ── Accounting ────────────────────────────────────────────────────────────
  {
    slug: "academic_accounting",
    topic: "Accounting and Financial Reporting",
    aliases: ["financial accounting", "managerial accounting", "auditing", "financial reporting"],
    keywords: [
      "accounting", "auditing", "financial reporting", "GAAP", "IFRS", "earnings management",
      "financial statements", "audit quality", "accruals", "revenue recognition", "disclosure",
      "tax", "internal control", "transparency", "fraud", "conservatism", "cost accounting",
      "management accounting", "budgeting", "performance measurement", "balanced scorecard"
    ],
    types: ["academic", "journal", "accounting"],
    priority_sources: [
      // ScienceDirect
      "https://rss.sciencedirect.com/publication/science/03613682",                        // Accounting Organizations and Society
      "https://rss.sciencedirect.com/publication/science/01654101",                        // Journal of Accounting and Economics
      // Wiley
      "https://onlinelibrary.wiley.com/action/showFeed?jc=1475679x&type=etoc&feed=rss",   // Journal of Accounting Research
      "https://onlinelibrary.wiley.com/action/showFeed?jc=19113846&type=etoc&feed=rss",   // Contemporary Accounting Research
    ]
  },

  // ── Marketing & Consumer Behavior ─────────────────────────────────────────
  {
    slug: "academic_marketing",
    topic: "Marketing and Consumer Behavior",
    aliases: ["consumer research", "brand management", "digital marketing", "market research"],
    keywords: [
      "marketing", "consumer", "brand", "advertising", "pricing", "segmentation", "targeting",
      "positioning", "customer", "purchase intention", "attitude", "perception", "loyalty",
      "engagement", "social media marketing", "digital marketing", "e-commerce", "CRM",
      "sales", "promotion", "product development", "market orientation", "customer satisfaction",
      "willingness to pay", "choice", "decision making", "nudge", "behavioural economics"
    ],
    types: ["academic", "journal", "marketing"],
    priority_sources: [
      // SAGE
      "https://journals.sagepub.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=jmxa",   // Journal of Marketing
      "https://journals.sagepub.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=mrja",   // Journal of Marketing Research
      // INFORMS
      "https://pubsonline.informs.org/action/showFeed?jc=mksc&type=etoc&feed=rss",        // Marketing Science
      // Wiley
      "https://onlinelibrary.wiley.com/action/showFeed?jc=15327663&type=etoc&feed=rss",   // Journal of Consumer Psychology
      // Oxford (Journal of Consumer Research)
      "https://academic.oup.com/rss/site_6378/advanceAccess_6156.xml",
    ]
  },

  // ── Entrepreneurship & Innovation ─────────────────────────────────────────
  {
    slug: "academic_entrepreneurship",
    topic: "Entrepreneurship and Innovation",
    aliases: ["startup research", "venture creation", "innovation management", "technology entrepreneurship"],
    keywords: [
      "entrepreneurship", "entrepreneur", "startup", "venture", "innovation", "new venture",
      "opportunity recognition", "bootstrapping", "incubator", "accelerator", "spin-off",
      "family business", "SME", "small business", "self-employment", "angel investor",
      "venture capital", "crowdfunding", "ecosystem", "R&D", "patent", "technology transfer",
      "disruptive innovation", "open innovation", "corporate entrepreneurship", "intrapreneurship"
    ],
    types: ["academic", "journal", "entrepreneurship", "innovation"],
    priority_sources: [
      // ScienceDirect
      "https://rss.sciencedirect.com/publication/science/08839026",                        // Journal of Business Venturing
      "https://rss.sciencedirect.com/publication/science/00487333",                        // Research Policy
      // SAGE
      "https://journals.sagepub.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=etpa",   // Entrepreneurship Theory and Practice
      // Wiley
      "https://onlinelibrary.wiley.com/action/showFeed?jc=1932443x&type=etoc&feed=rss",   // Strategic Entrepreneurship Journal
    ]
  },

  // ── Operations, Supply Chain & Logistics ──────────────────────────────────
  {
    slug: "academic_operations",
    topic: "Operations Management and Supply Chain",
    aliases: ["supply chain management", "logistics", "operations research", "process management"],
    keywords: [
      "operations", "supply chain", "logistics", "inventory", "scheduling", "queuing",
      "lean", "six sigma", "quality management", "TQM", "process improvement", "manufacturing",
      "production", "service operations", "capacity planning", "demand forecasting",
      "procurement", "sourcing", "distribution", "warehouse", "just in time", "agile",
      "resilience", "disruption", "simulation", "optimization", "linear programming"
    ],
    types: ["academic", "journal", "operations"],
    priority_sources: [
      // Wiley
      "https://onlinelibrary.wiley.com/action/showFeed?jc=18731317&type=etoc&feed=rss",   // Journal of Operations Management
      "https://onlinelibrary.wiley.com/action/showFeed?jc=19375956&type=etoc&feed=rss",   // Production and Operations Management
      // INFORMS
      "https://pubsonline.informs.org/action/showFeed?jc=msom&type=etoc&feed=rss",        // Manufacturing and Service Operations Management
      "https://pubsonline.informs.org/action/showFeed?jc=opre&type=etoc&feed=rss",        // Operations Research
      "https://pubsonline.informs.org/action/showFeed?jc=mnsc&type=etoc&feed=rss",        // Management Science
    ]
  },

  // ── Information Systems & Technology Management ────────────────────────────
  {
    slug: "academic_information_systems",
    topic: "Information Systems and Technology Management",
    aliases: ["MIS", "IT management", "digital transformation", "business IT"],
    keywords: [
      "information systems", "IS", "MIS", "IT", "digital", "technology adoption", "ERP",
      "cloud computing", "artificial intelligence", "machine learning", "big data", "analytics",
      "blockchain", "cybersecurity", "privacy", "digital transformation", "platform",
      "social media", "e-commerce", "fintech", "algorithm", "automation", "digital economy",
      "TAM", "technology acceptance", "user behavior", "system design", "agile development"
    ],
    types: ["academic", "journal", "information systems", "technology"],
    priority_sources: [
      // INFORMS
      "https://pubsonline.informs.org/action/showFeed?jc=isre&type=etoc&feed=rss",        // Information Systems Research
      // Taylor & Francis
      "https://www.tandfonline.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=mmis20",  // Journal of Management Information Systems
      // INFORMS
      "https://pubsonline.informs.org/action/showFeed?jc=mnsc&type=etoc&feed=rss",        // Management Science
    ]
  },

  // ── Organizational Behavior & Human Resources ──────────────────────────────
  {
    slug: "academic_organizational_behavior",
    topic: "Organizational Behavior and Human Resources",
    aliases: ["OB", "HR research", "workplace behavior", "industrial psychology"],
    keywords: [
      "organizational behavior", "human resources", "HR", "motivation", "job satisfaction",
      "engagement", "turnover", "recruitment", "selection", "training", "performance appraisal",
      "compensation", "diversity", "inclusion", "equity", "leadership", "team", "group dynamics",
      "conflict", "negotiation", "communication", "trust", "justice", "burnout", "stress",
      "well-being", "psychological safety", "personality", "emotion", "identity", "culture"
    ],
    types: ["academic", "journal", "organizational behavior", "human resources"],
    priority_sources: [
      // ScienceDirect
      "https://rss.sciencedirect.com/publication/science/07495978",                        // Organizational Behavior and Human Decision Processes
      // SAGE
      "https://journals.sagepub.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=huma",   // Human Relations
      "https://journals.sagepub.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=asqa",   // Administrative Science Quarterly
      "https://journals.sagepub.com/action/showFeed?ui-pref-journal-access-indicator=none&feed=rss&jc=ossa",   // Organization Studies
      // Wiley
      "https://onlinelibrary.wiley.com/action/showFeed?jc=1099050x&type=etoc&feed=rss",   // Human Resource Management
      // APA
      "https://www.apa.org/pubs/journals/rss/apl-rss.xml",                                // Journal of Applied Psychology
      // AOM
      "https://journals.aom.org/action/showFeed?type=etoc&feed=rss&jc=amj",
    ]
  },

  // ── Business Press & General Practice ─────────────────────────────────────
  {
    slug: "academic_business_practice",
    topic: "Business Practice and Applied Research",
    aliases: ["HBR", "business review", "management practice", "applied business"],
    keywords: [
      "business", "management practice", "case study", "best practice", "leadership",
      "strategy execution", "change management", "transformation", "culture", "talent",
      "innovation", "growth", "sustainability", "ESG", "corporate responsibility",
      "digital strategy", "agile", "design thinking", "data driven", "analytics"
    ],
    types: ["practitioner", "journal", "business"],
    priority_sources: [
      // Harvard Business Review
      "https://feeds.hbr.org/harvardbusiness",
      // MIT Sloan Management Review
      "https://sloanreview.mit.edu/feed/",
    ]
  }
];

// ── Seeder ────────────────────────────────────────────────────────────────────

/**
 * Bump this whenever ACADEMIC_SUBJECTS changes — seedIfNeeded() compares
 * this version against what's stored in _meta.academicJournalSeedVersion.
 */
const SEED_VERSION = 2;

/**
 * Open-access API providers added to EVERY subject.
 * These are named strings that articleHarvester.SOURCE_NAME_TO_FETCHER resolves:
 *   "core"            → CORE API (core.ac.uk) — 200M+ open-access papers, needs CORE_API_KEY
 *   "semanticscholar" → Semantic Scholar — 200M+ papers, open-access PDF when available
 *   "doaj"            → DOAJ — only open-access journals, no key needed
 *
 * These sit alongside any RSS TOC feeds in the array. The harvester dispatches
 * URLs (https://...) to the RSS fetcher and named strings to the API fetchers.
 */
const BASE_OPEN_ACCESS_PROVIDERS = ["core", "semanticscholar", "doaj"];

/**
 * Seed all academic journal subjects into research-sources.json.
 * Each subject gets the named open-access API providers PLUS its RSS TOC feeds.
 * Uses upsertSubject() which merges arrays — safe to run multiple times.
 *
 * @returns {Promise<{seeded: number, failed: number, totalSources: number}>}
 */
export async function seedAcademicJournals() {
  log(`Starting academic journal seed v${SEED_VERSION}...`, "info");
  let seeded = 0;
  let failed = 0;

  for (const subj of ACADEMIC_SUBJECTS) {
    try {
      // Merge: named API providers first (preferred), RSS feeds as secondary (title/abstract)
      const combinedSources = [...BASE_OPEN_ACCESS_PROVIDERS, ...subj.priority_sources];
      await upsertSubject(subj.slug, {
        topic:            subj.topic,
        aliases:          subj.aliases,
        keywords:         subj.keywords,
        types:            subj.types,
        priority_sources: combinedSources,
        createdFrom:      "academicJournalSeeder"
      });
      seeded++;
      log(`Seeded: ${subj.slug} (${combinedSources.length} sources)`, "info");
    } catch (err) {
      failed++;
      log(`Failed to seed ${subj.slug}: ${err.message}`, "warn");
    }
  }

  // Write version flag so seedIfNeeded() knows this version is already applied
  try {
    const data = await load();
    data._meta.academicJournalsSeeded = new Date().toISOString();
    data._meta.academicJournalSeedVersion = SEED_VERSION;
    data._meta.academicJournalCount = ACADEMIC_SUBJECTS.length;
    await save(data);
  } catch (err) {
    log(`Failed to write seed flag: ${err.message}`, "warn");
  }

  log(`Seed v${SEED_VERSION} complete: ${seeded} subjects, ${failed} errors`, "info");
  console.log(`📚 [deepResearch] Academic seed v${SEED_VERSION}: ${seeded} subjects (CORE + Semantic Scholar + DOAJ + RSS) — ${failed} errors`);
  return { seeded, failed, totalSources: seeded * (BASE_OPEN_ACCESS_PROVIDERS.length + 5) };
}

/**
 * Check whether the current seed version is already applied.
 * @returns {Promise<boolean>}
 */
export async function isSeeded() {
  try {
    const data = await load();
    return data._meta?.academicJournalSeedVersion === SEED_VERSION;
  } catch {
    return false;
  }
}

/**
 * Run the seeder only if this version hasn't been applied yet.
 * Called non-blocking from deepResearch/index.js on startup.
 */
export async function seedIfNeeded() {
  try {
    if (await isSeeded()) {
      log(`Academic seed v${SEED_VERSION} already applied — skipping`, "info");
      return { seeded: 0, failed: 0, skipped: true };
    }
    log(`Academic seed v${SEED_VERSION} not yet applied — running...`, "info");
    return await seedAcademicJournals();
  } catch (err) {
    log(`seedIfNeeded error: ${err.message}`, "warn");
    return { seeded: 0, failed: 0, error: err.message };
  }
}
