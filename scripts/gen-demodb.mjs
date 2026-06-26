// Generates packages/db-client/src/demo/demodb-schema.sql — a realistic
// CRM + knowledge-base demo for the sqlite-anki playground.
//
//   node scripts/gen-demodb.mjs
//
// Output layout: DDL + _meta_columns + cheap (non-vector) data, then a
// "--==VECTORS==--" marker, then ONE insert per line for the anki vtables so
// the worker can stream embedding progress. Deterministic (seeded PRNG).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- deterministic RNG ----
let seed = 0x9e3779b9;
function rnd() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const sample = (a, n) => {
  const c = [...a];
  const out = [];
  while (out.length < n && c.length) out.push(c.splice(Math.floor(rnd() * c.length), 1)[0]);
  return out;
};
function date(daysAgoMax) {
  const d = new Date(Date.now() - int(0, daysAgoMax) * 86400000);
  return d.toISOString().slice(0, 10);
}
const q = (s) => `'${String(s).replace(/\s+/g, " ").trim().replace(/'/g, "''")}'`;

// ---- vocab ----
const INDUSTRIES = ["Manufacturing", "Healthcare", "Retail", "Finance", "SaaS", "Education", "Logistics"];
const REGIONS = ["North America", "EMEA", "APAC", "LATAM"];
const TIERS = ["Enterprise", "Mid-Market", "SMB"];
const ACC_STATUS = ["Active", "Prospect", "Churned", "On Hold"];
const ROOT = ["Atlas", "Northwind", "Vertex", "Summit", "Cobalt", "Lumen", "Pioneer", "Meridian", "Orchid", "Granite", "Beacon", "Cedar", "Quantum", "Harbor", "Aspen", "Nimbus", "Forge", "Delta", "Helix", "Onyx", "Solstice", "Brightline", "Ironclad", "Cascade", "Vanguard"];
const SUFFIX = ["Industries", "Health", "Retail Group", "Capital", "Cloud", "Labs", "Logistics", "Systems", "Partners", "Technologies", "Networks", "Analytics"];
const FIRST = ["Avery", "Jordan", "Riley", "Morgan", "Casey", "Taylor", "Sam", "Jamie", "Drew", "Quinn", "Reese", "Skyler", "Devon", "Parker", "Rowan", "Elliot", "Harper", "Noa", "Kai", "Maya", "Liam", "Priya", "Chen", "Ines", "Omar", "Sofia"];
const LAST = ["Nguyen", "Patel", "Garcia", "Smith", "Kim", "Johnson", "Müller", "Rossi", "Silva", "Khan", "Okafor", "Andersson", "Costa", "Haddad", "Park", "Novak", "Fischer", "Walsh", "Ibrahim", "Tan"];
const TITLES = ["VP Engineering", "CTO", "IT Director", "Procurement Lead", "Head of Security", "Operations Manager", "CFO", "Platform Architect", "Product Manager", "Support Lead", "Data Engineer", "Compliance Officer"];
const STAGES = ["Discovery", "Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost"];
const PRIORITY = ["Low", "Medium", "High", "Critical"];
const SEVERITY = ["S1", "S2", "S3", "S4"];
const TICKET_STATUS = ["Open", "In Progress", "Waiting on Customer", "Resolved", "Closed"];
const KB_CATEGORY = ["Onboarding", "Security", "Integration", "Operations", "Migration", "Performance", "Reliability"];
const KB_TAGS = ["setup", "sso", "api", "backup", "scaling", "compliance", "migration", "ai", "monitoring", "networking", "auth", "recovery"];
const INTER_KIND = ["Email", "Meeting", "Phone Call", "Demo", "Support", "Training"];
const INTER_CHANNEL = ["Zoom", "In Person", "Phone", "Email", "Slack"];

// Theme banks — overlapping enterprise concepts so semantic search can connect
// related rows that don't share keywords.
const THEMES = {
  rollout: ["a phased enterprise rollout across business units", "expanding the deployment to additional teams", "scaling adoption company-wide after the pilot", "onboarding thousands of users in the next quarter"],
  budget: ["budget approval is pending with finance", "the deal is blocked on Q3 budget sign-off", "pricing was renegotiated to fit the annual budget", "procurement needs an updated quote for approval"],
  exec: ["executive sponsorship from the CTO is secured", "the CFO is championing this initiative internally", "leadership wants a board-ready summary", "the sponsor is pushing for a faster timeline"],
  renewal: ["renewal is at risk due to low usage", "the customer is evaluating competitors before renewing", "an expansion opportunity around the renewal", "renewal conversation tied to a multi-year commitment"],
  cloud: ["migrating their workloads to the cloud", "a lift-and-shift to a managed cloud environment", "concerns about downtime during cloud migration", "consolidating on-prem systems into the cloud"],
  sso: ["rolling out single sign-on with their identity provider", "SSO configuration with SAML and SCIM", "users could not sign in after the identity-provider switch", "enforcing MFA through the corporate directory"],
  security: ["a security review by the InfoSec team", "passing a SOC 2 and penetration-testing audit", "hardening access controls and audit logging", "data residency and encryption requirements"],
  compliance: ["meeting HIPAA and GDPR compliance obligations", "documenting controls for an upcoming audit", "regulatory requirements in the finance vertical", "retention policies for sensitive records"],
  perf: ["search latency spikes under heavy load", "tuning performance for large datasets", "slow query times on a multi-gigabyte database", "optimizing indexing for faster retrieval"],
  api: ["integrating through the public REST API", "API authentication with rotating tokens", "webhooks for near real-time synchronization", "rate limits affecting their integration"],
  datamig: ["migrating existing records from a legacy system", "a one-time bulk import of historical data", "mapping fields during the data migration", "validating data integrity after the migration"],
  ai: ["adopting AI-assisted semantic search", "embedding-based retrieval over their documents", "evaluating local, in-browser inference", "replacing keyword search with meaning-based search"],
  success: ["a customer-success plan to drive adoption", "quarterly business reviews to track value", "a champion who advocates internally", "measuring time-to-value after launch"],
  training: ["scheduling end-user training sessions", "enablement workshops for the admin team", "self-serve documentation and onboarding guides", "reducing support volume through training"],
  feedback: ["positive product feedback from power users", "a feature request around exporting data", "usability concerns raised during the trial", "requests for deeper reporting and dashboards"],
  escalation: ["a support escalation to the engineering team", "an outage that triggered a priority incident", "the issue recurred after the previous fix", "a workaround was provided pending a permanent fix"],
};
const THEME_KEYS = Object.keys(THEMES);
const NEXT = ["Schedule an architecture review with the security team.", "Send the updated proposal and pricing to procurement.", "Book a follow-up demo for the wider team.", "Confirm the migration timeline with their platform owners.", "Loop in the executive sponsor for sign-off.", "Prepare a SOC 2 summary for InfoSec.", "Set up a technical proof-of-concept environment.", "Draft a rollout plan for the next quarter.", "Align on success metrics for the first 90 days.", "Coordinate an SSO configuration session."];

function blurb(keys, n) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const k = keys[i % keys.length];
    parts.push(pick(THEMES[k]));
  }
  // Title-case first letter, join into a couple of sentences.
  return parts.map((p, i) => (i === 0 ? `The team is focused on ${p}.` : `They also mentioned ${p}.`)).join(" ");
}
function themesFor() {
  return chance(0.55) ? sample(THEME_KEYS, 2) : [pick(THEME_KEYS)];
}

// ---- build rows ----
const out = [];
const push = (s) => out.push(s);

push("-- Generated by scripts/gen-demodb.mjs — sqlite-anki demo database.");
push("-- A small CRM + knowledge base: standard tables + anki virtual tables");
push("-- with multiple TEXT VECTOR columns. ~870 rows.\n");

push(`CREATE TABLE accounts (
  id INTEGER PRIMARY KEY, name TEXT, industry TEXT, region TEXT,
  tier TEXT, status TEXT, created_at TEXT
);`);
push(`CREATE TABLE contacts (
  id INTEGER PRIMARY KEY, account_id INTEGER, name TEXT, title TEXT, email TEXT
);`);
push(`CREATE TABLE interactions (
  id INTEGER PRIMARY KEY, account_id INTEGER, contact_id INTEGER,
  kind TEXT, channel TEXT, happened_at TEXT, notes TEXT
);`);
push(`CREATE VIRTUAL TABLE opportunities USING anki(
  id INTEGER PRIMARY KEY, account_id INTEGER, title TEXT, stage TEXT,
  priority TEXT, amount INTEGER,
  summary TEXT VECTOR, customer_notes TEXT VECTOR, next_steps TEXT VECTOR
);`);
push(`CREATE VIRTUAL TABLE support_tickets USING anki(
  id INTEGER PRIMARY KEY, account_id INTEGER, severity TEXT, status TEXT,
  subject TEXT,
  problem TEXT VECTOR, resolution TEXT VECTOR, internal_notes TEXT VECTOR
);`);
push(`CREATE VIRTUAL TABLE knowledge_articles USING anki(
  id INTEGER PRIMARY KEY, title TEXT, category TEXT, tags TEXT,
  abstract TEXT VECTOR, body TEXT VECTOR, troubleshooting TEXT VECTOR
);`);
push(`CREATE VIEW pipeline AS
  SELECT a.name AS account, o.title, o.stage, o.priority, o.amount
  FROM opportunities o JOIN accounts a ON a.id = o.account_id;`);

// column descriptions
push(`CREATE TABLE _meta_columns (tbl TEXT, col TEXT, description TEXT);`);
const META = [
  ["accounts", "name", "Customer company name"],
  ["accounts", "industry", "Primary industry vertical"],
  ["accounts", "tier", "Segment: Enterprise, Mid-Market or SMB"],
  ["accounts", "status", "Account lifecycle status"],
  ["contacts", "title", "Job title of the contact"],
  ["opportunities", "summary", "Embedded one-line summary of the deal"],
  ["opportunities", "customer_notes", "Embedded free-text notes captured from the customer"],
  ["opportunities", "next_steps", "Embedded planned next actions for the deal"],
  ["support_tickets", "problem", "Embedded description of the reported problem"],
  ["support_tickets", "resolution", "Embedded resolution applied to the ticket"],
  ["support_tickets", "internal_notes", "Embedded private engineering notes"],
  ["knowledge_articles", "abstract", "Embedded short summary of the article"],
  ["knowledge_articles", "body", "Embedded full article body"],
  ["knowledge_articles", "troubleshooting", "Embedded troubleshooting guidance"],
];
for (const [t, c, d] of META) push(`INSERT INTO _meta_columns VALUES (${q(t)}, ${q(c)}, ${q(d)});`);

// accounts
const accounts = [];
for (let i = 1; i <= 50; i++) {
  accounts.push({ id: i, name: `${pick(ROOT)} ${pick(SUFFIX)}`, industry: pick(INDUSTRIES), region: pick(REGIONS), tier: pick(TIERS), status: pick(ACC_STATUS), created_at: date(900) });
}
push("\n-- accounts");
for (const a of accounts)
  push(`INSERT INTO accounts VALUES (${a.id}, ${q(a.name)}, ${q(a.industry)}, ${q(a.region)}, ${q(a.tier)}, ${q(a.status)}, ${q(a.created_at)});`);

// contacts
const contacts = [];
for (let i = 1; i <= 120; i++) {
  const acc = pick(accounts);
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  contacts.push({ id: i, account_id: acc.id, name, title: pick(TITLES), email: `${name.toLowerCase().replace(/[^a-z]/g, ".")}@${acc.name.toLowerCase().replace(/[^a-z]/g, "")}.com` });
}
push("\n-- contacts");
for (const c of contacts)
  push(`INSERT INTO contacts VALUES (${c.id}, ${c.account_id}, ${q(c.name)}, ${q(c.title)}, ${q(c.email)});`);

// interactions
push("\n-- interactions");
for (let i = 1; i <= 300; i++) {
  const c = pick(contacts);
  const th = themesFor();
  const notes = blurb(th, int(1, 2));
  push(`INSERT INTO interactions VALUES (${i}, ${c.account_id}, ${c.id}, ${q(pick(INTER_KIND))}, ${q(pick(INTER_CHANNEL))}, ${q(date(365))}, ${q(notes)});`);
}

// ---- vector tables (one insert per line, streamed with progress) ----
push("\n--==VECTORS==--");

for (let i = 1; i <= 150; i++) {
  const acc = pick(accounts);
  const th = themesFor();
  const title = `${pick(["Enterprise", "Platform", "Cloud", "Security", "Analytics", "Global"])} ${pick(["expansion", "rollout", "renewal", "migration", "modernization", "deal"])} — ${acc.name}`;
  const summary = blurb(th, int(1, 2));
  const notes = `Customer ${chance(0.5) ? "is excited about" : "is concerned about"} ${pick(THEMES[th[0]])}. ${blurb(th, 1)}`;
  const next = sample(NEXT, int(1, 2)).join(" ");
  push(`INSERT INTO opportunities VALUES (${i}, ${acc.id}, ${q(title)}, ${q(pick(STAGES))}, ${q(pick(PRIORITY))}, ${int(5, 500) * 1000}, ${q(summary)}, ${q(notes)}, ${q(next)});`);
}

const SUBJECTS = ["Login failures after SSO change", "Slow search on large dataset", "API returns 401 intermittently", "Data import stuck halfway", "Backup job did not run", "High latency during peak hours", "Migration validation errors", "MFA prompts not appearing", "Webhook deliveries delayed", "Dashboard not loading"];
for (let i = 1; i <= 150; i++) {
  const acc = pick(accounts);
  const th = themesFor();
  const problem = `${pick(["Users report", "The customer reports", "We observed"])} ${pick(THEMES[th[0]])}. ${blurb(th, 1)}`;
  const resolution = chance(0.7) ? `Resolved by addressing ${pick(THEMES[th[th.length - 1]])}.` : "Investigation ongoing; a workaround was shared with the customer.";
  const internal = `Internal: similar to a prior case involving ${pick(THEMES[pick(THEME_KEYS)])}.`;
  push(`INSERT INTO support_tickets VALUES (${i}, ${acc.id}, ${q(pick(SEVERITY))}, ${q(pick(TICKET_STATUS))}, ${q(pick(SUBJECTS))}, ${q(problem)}, ${q(resolution)}, ${q(internal)});`);
}

const KB_TOPICS = ["Installation Guide", "Security Checklist", "SSO Migration", "API Authentication", "Enterprise Rollout", "Backup Strategy", "Disaster Recovery", "AI Integration", "Performance Tuning", "Troubleshooting Guide", "Data Migration Playbook", "Compliance Overview"];
for (let i = 1; i <= 100; i++) {
  const th = themesFor();
  const title = `${pick(KB_TOPICS)}${chance(0.4) ? " for " + pick(INDUSTRIES) : ""}`;
  const abstract = blurb(th, 1);
  const body = blurb(th, int(2, 3)) + " This guide walks through the recommended approach step by step.";
  const trouble = `If you hit issues, check ${pick(THEMES[th[0]])} and review the related logs.`;
  push(`INSERT INTO knowledge_articles VALUES (${i}, ${q(title)}, ${q(pick(KB_CATEGORY))}, ${q(sample(KB_TAGS, int(2, 4)).join(", "))}, ${q(abstract)}, ${q(body)}, ${q(trouble)});`);
}

const sql = out.join("\n") + "\n";
const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, "../packages/db-client/src/demo/demodb-schema.sql");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, sql);
const vectorRows = 150 + 150 + 100;
console.log(`wrote ${dest} (${(sql.length / 1024).toFixed(0)} KB, ${vectorRows} embedding inserts)`);
