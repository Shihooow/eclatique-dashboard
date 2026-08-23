#!/usr/bin/env node
/**
 * Eclatiqueマーケティングダッシュボード 日次自動更新スクリプト
 *
 * GitHub Actions のcronから実行される想定。以下を取得・集計し、
 * リポジトリ直下の index.html 内の下記定数だけを書き換える:
 *   LAST_UPDATED, HP_METRICS, VISION_STATS, CLIENT_STATS, REELS
 * IG_HISTORY / PODCAST_HISTORY / PODCAST_EPISODES はこのスクリプトのスコープ外
 * （別途 Claude in Chrome のタスクが週次で更新する）。
 *
 * 必要な環境変数（GitHub Actions の Secrets から渡す）:
 *   GOOGLE_SERVICE_ACCOUNT_JSON - GCPサービスアカウントのJSON鍵（文字列そのまま）
 *   WIX_API_KEY                 - Wix APIキー（analytics読み取り専用スコープ）
 *   NOTION_TOKEN                - Notion Internal Integration の Access Token
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createSign } from "node:crypto";

const SITE_ID = "3cc7e041-3052-4615-8315-9804a7e13f4e";
const VISION_SHEET_ID = "1vdOZxV5vnD6mU8PYKmpRGWPqStR5N4gT-gvVy9Aey0M"; // 00_未顧客DB（旧称ビジョン診断シート）
const VISION_TAB = "visionsheet";
const CLIENT_SHEET_ID = "1BaaSdB6w1jMw634SvydAZ0RT_PZSkE6cs7bJeXaR0TU"; // 00_既存顧客DB
const CLIENT_TAB = "FBP申し込み";
const NOTION_DATABASE_ID = "3b6f848e-722e-8083-99eb-000bdcbd1cd8"; // Reels
const INDEX_HTML_PATH = new URL("../index.html", import.meta.url);

const EXCLUDE_EMAILS = new Set([
  "skyblueeeeeeeee0705@gmail.com",
  "s0705_happiness@yahoo.co.jp",
]);
const EXCLUDE_NAME_SUBSTR = "府川";
const VISION_CUTOFF = new Date("2026-05-01T00:00:00");

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// ---------------------------------------------------------------------------
// Google Sheets: service-account JWT auth (no external deps)
// ---------------------------------------------------------------------------
function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getGoogleAccessToken(serviceAccountJson) {
  const creds = JSON.parse(serviceAccountJson);
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: creds.token_uri,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(creds.private_key);
  const sigB64 = signature.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${unsigned}.${sigB64}`;

  const res = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token;
}

async function fetchSheetRows(accessToken, spreadsheetId, tabName) {
  const range = encodeURIComponent(tabName);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`Sheets API failed for ${spreadsheetId}/${tabName}: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.values || [];
}

// ---------------------------------------------------------------------------
// Generic "stacked named tables in one tab" extraction
// ---------------------------------------------------------------------------
function isBlankRow(row) {
  return !row || row.every((cell) => cell === undefined || cell === null || String(cell).trim() === "");
}

/**
 * headerRequiredCells: 配列。この全ての文字列を「完全一致」で含むヘッダー行を探す。
 * 戻り値: { headerIndex, colIndex(name) -> index, rows: 2D配列（データ行のみ） }
 */
function extractTable(allRows, headerRequiredCells) {
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i] || [];
    const trimmed = row.map((c) => (c === undefined || c === null ? "" : String(c).trim()));
    const hasAll = headerRequiredCells.every((req) => trimmed.includes(req));
    if (!hasAll) continue;

    const header = trimmed;
    const dataRows = [];
    for (let j = i + 1; j < allRows.length; j++) {
      if (isBlankRow(allRows[j])) break;
      dataRows.push(allRows[j]);
    }
    return { headerIndex: i, header, dataRows };
  }
  return null;
}

function colIndexOf(header, name) {
  return header.indexOf(name);
}

function cell(row, idx) {
  if (idx < 0 || idx >= row.length) return "";
  const v = row[idx];
  return v === undefined || v === null ? "" : String(v).trim();
}

function isExcludedRow(name, email) {
  if (email && EXCLUDE_EMAILS.has(email.trim())) return true;
  if (name && name.includes(EXCLUDE_NAME_SUBSTR)) return true;
  return false;
}

function parseSheetTimestamp(raw) {
  if (!raw) return null;
  // "2026/05/06 21:55:22" or "2026/05/06" 形式を想定
  const normalized = raw.replace(/\//g, "-");
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

function computeVisionStats(allRows) {
  const table = extractTable(allRows, ["ステータス", "個別面談日"]);
  if (!table) {
    console.warn("[vision] header row not found; defaulting to zeros");
    return { newCycleSubmissions: 0, meetingsHeld: 0, applications: 0 };
  }
  const { header, dataRows } = table;
  const idxTimestamp = colIndexOf(header, "タイムスタンプ");
  const idxName = colIndexOf(header, "お名前");
  const idxEmail = colIndexOf(header, "メールアドレス");
  const idxStatus = colIndexOf(header, "ステータス");
  const idxMeetingDate = colIndexOf(header, "個別面談日");
  const idxApplyDate = colIndexOf(header, "申込日");

  let newCycleSubmissions = 0;
  let meetingsHeld = 0;
  let applications = 0;

  for (const row of dataRows) {
    const name = cell(row, idxName);
    const email = cell(row, idxEmail);
    if (isExcludedRow(name, email)) continue;

    const ts = parseSheetTimestamp(cell(row, idxTimestamp));
    if (!ts || ts < VISION_CUTOFF) continue;

    newCycleSubmissions++;
    if (cell(row, idxMeetingDate) !== "") meetingsHeld++;
    const applyDate = cell(row, idxApplyDate);
    const status = cell(row, idxStatus);
    if (applyDate !== "" || status.includes("申込")) applications++;
  }

  return { newCycleSubmissions, meetingsHeld, applications };
}

function computeClientStats(allRows) {
  const table = extractTable(allRows, ["ご希望のプランをお選びください"]);
  if (!table) {
    console.warn("[client] header row not found; defaulting to zeros");
    return { light: 0, standard: 0, premium: 0 };
  }
  const { header, dataRows } = table;
  const idxName = colIndexOf(header, "お名前");
  const idxEmail = colIndexOf(header, "メールアドレス");
  const idxPlan = colIndexOf(header, "ご希望のプランをお選びください");

  let light = 0;
  let standard = 0;
  let premium = 0;

  for (const row of dataRows) {
    const name = cell(row, idxName);
    const email = cell(row, idxEmail);
    if (isExcludedRow(name, email)) continue;

    const plan = cell(row, idxPlan);
    if (plan.includes("スタンダード")) standard++;
    if (plan.includes("ライト")) light++;
    if (plan.includes("プレミアム")) premium++;
  }

  return { light, standard, premium };
}

// ---------------------------------------------------------------------------
// Wix Analytics
// ---------------------------------------------------------------------------
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchWixWindow(apiKey, days) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const params = new URLSearchParams();
  params.set("dateRange.startDate", isoDate(start));
  params.set("dateRange.endDate", isoDate(end));
  for (const t of ["TOTAL_SESSIONS", "TOTAL_UNIQUE_VISITORS", "TOTAL_FORMS_SUBMITTED", "CLICKS_TO_CONTACT"]) {
    params.append("measurementTypes", t);
  }
  const url = `https://www.wixapis.com/analytics/v2/site-analytics/data?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: apiKey,
      "wix-site-id": SITE_ID,
    },
  });
  if (!res.ok) {
    throw new Error(`Wix analytics failed (${days}d): ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const byType = Object.fromEntries((json.data || []).map((d) => [d.type, d]));

  const sessions = byType.TOTAL_SESSIONS || { total: 0, values: [] };
  const visitors = byType.TOTAL_UNIQUE_VISITORS || { total: 0, values: [] };
  const forms = byType.TOTAL_FORMS_SUBMITTED || { total: 0, values: [] };
  const contact = byType.CLICKS_TO_CONTACT || { total: 0, values: [] };

  return {
    sessions: sessions.total || 0,
    visitors: visitors.total || 0,
    forms: forms.total || 0,
    contact: contact.total || 0,
    series: (sessions.values || []).map((v) => ({ date: v.date, value: v.value })),
  };
}

async function fetchHpMetrics(apiKey) {
  const [d7, d30, d60] = await Promise.all([
    fetchWixWindow(apiKey, 7),
    fetchWixWindow(apiKey, 30),
    fetchWixWindow(apiKey, 60),
  ]);
  return { 7: d7, 30: d30, 60: d60 };
}

// ---------------------------------------------------------------------------
// Notion Reels
// ---------------------------------------------------------------------------
function notionTitle(prop) {
  if (!prop || !prop.title) return "";
  return prop.title.map((t) => t.plain_text).join("");
}
function notionNumber(prop) {
  return prop && typeof prop.number === "number" ? prop.number : 0;
}
function notionDateStart(prop) {
  return prop && prop.date && prop.date.start ? prop.date.start : null;
}

async function fetchReels(notionToken) {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      page_size: 50,
      sorts: [{ property: "Date", direction: "descending" }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return (json.results || []).slice(0, 3).map((page) => {
    const p = page.properties;
    return {
      name: notionTitle(p.Name),
      reel_date: notionDateStart(p.Date),
      plays: notionNumber(p["再生回数"]),
      reach: notionNumber(p["リーチ"]),
      likes: notionNumber(p["いいね"]),
      comments: notionNumber(p["コメント"]),
      saves: notionNumber(p["保存"]),
      shares: notionNumber(p["シェア"]),
      avg_watch: notionNumber(p["平均視聴時間_秒"]),
      skip_rate: notionNumber(p["スキップ率_%"]),
    };
  });
}

// ---------------------------------------------------------------------------
// index.html rewrite
// ---------------------------------------------------------------------------
function buildConstantsBlock({ lastUpdated, hpMetrics, visionStats, clientStats, reels }) {
  const hp = (w) =>
    `  ${w}: {\n` +
    `    sessions: ${hpMetrics[w].sessions}, visitors: ${hpMetrics[w].visitors}, forms: ${hpMetrics[w].forms}, contact: ${hpMetrics[w].contact},\n` +
    `    series: ${JSON.stringify(hpMetrics[w].series)}\n` +
    `  }`;

  const reelsLines = reels
    .map(
      (r) =>
        `  { name: ${JSON.stringify(r.name)}, reel_date: ${JSON.stringify(r.reel_date)}, plays: ${r.plays}, reach: ${r.reach}, likes: ${r.likes}, comments: ${r.comments}, saves: ${r.saves}, shares: ${r.shares}, avg_watch: ${r.avg_watch}, skip_rate: ${r.skip_rate} }`
    )
    .join(",\n");

  return (
    `const LAST_UPDATED = "${lastUpdated}";\n\n` +
    `const HP_METRICS = {\n${hp(7)},\n${hp(30)},\n${hp(60)}\n};\n\n` +
    `// 無料診断→面談→申込のファネル（2026-05-01以降・しほさん自身のテスト送信を除く）\n` +
    `const VISION_STATS = { newCycleSubmissions: ${visionStats.newCycleSubmissions}, meetingsHeld: ${visionStats.meetingsHeld}, applications: ${visionStats.applications} };\n` +
    `// スタンダード/ライト/プレミアム 成約件数（しほさん自身のテスト送信を除く）\n` +
    `const CLIENT_STATS = { light: ${clientStats.light}, standard: ${clientStats.standard}, premium: ${clientStats.premium} };\n\n` +
    `const REELS = [\n${reelsLines}\n];`
  );
}

function rewriteIndexHtml(html, constantsBlock) {
  const startMarker = "const LAST_UPDATED";
  const endMarker = "const IG_HISTORY";
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error("Could not locate LAST_UPDATED..IG_HISTORY block in index.html; aborting to avoid corrupting the file.");
  }
  const before = html.slice(0, startIdx);
  const after = html.slice(endIdx);
  return `${before}${constantsBlock}\n\n${after}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const serviceAccountJson = must("GOOGLE_SERVICE_ACCOUNT_JSON");
  const wixApiKey = must("WIX_API_KEY");
  const notionToken = must("NOTION_TOKEN");

  console.log("Authenticating with Google...");
  const accessToken = await getGoogleAccessToken(serviceAccountJson);

  console.log("Fetching Google Sheets data...");
  const [visionRows, clientRows] = await Promise.all([
    fetchSheetRows(accessToken, VISION_SHEET_ID, VISION_TAB),
    fetchSheetRows(accessToken, CLIENT_SHEET_ID, CLIENT_TAB),
  ]);
  const visionStats = computeVisionStats(visionRows);
  const clientStats = computeClientStats(clientRows);
  console.log("VISION_STATS:", visionStats);
  console.log("CLIENT_STATS:", clientStats);

  console.log("Fetching Wix analytics...");
  const hpMetrics = await fetchHpMetrics(wixApiKey);
  console.log(
    "HP_METRICS totals:",
    Object.fromEntries(Object.entries(hpMetrics).map(([k, v]) => [k, { sessions: v.sessions, visitors: v.visitors }]))
  );

  console.log("Fetching Notion Reels...");
  const reels = await fetchReels(notionToken);
  console.log("REELS:", reels.map((r) => r.name));

  const lastUpdated = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const constantsBlock = buildConstantsBlock({ lastUpdated, hpMetrics, visionStats, clientStats, reels });

  const html = readFileSync(INDEX_HTML_PATH, "utf8");
  const updated = rewriteIndexHtml(html, constantsBlock);
  writeFileSync(INDEX_HTML_PATH, updated, "utf8");

  console.log("index.html updated. LAST_UPDATED =", lastUpdated);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://" + process.cwd() + "/").href;
if (isMain || process.argv[1]?.endsWith("update-dashboard.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { computeVisionStats, computeClientStats, extractTable, isExcludedRow, buildConstantsBlock, rewriteIndexHtml };
