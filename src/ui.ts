type DataRow = Record<string, unknown>;

interface RenderResult {
  tone?: "success" | "error" | "info";
  title?: string;
  message?: string;
  normalizedUrl?: string;
}

const STATE_LABELS: Record<string, string> = {
  observed: "Observed",
  inferred: "Inferred",
  "tested-pass": "Tested — pass",
  "tested-fail": "Tested — fail",
  unknown: "Unknown",
  "not-tested": "Not tested",
};

const STATE_EXPLANATIONS: Record<string, string> = {
  observed: "Directly present in public metadata or an unauthenticated response.",
  inferred: "An evidence-supported hypothesis; not directly established by the scanner.",
  "tested-pass": "The named harmless check passed. This is not a general security guarantee.",
  "tested-fail": "The named harmless check failed under the recorded observation.",
  unknown: "The available public evidence cannot determine this property.",
  "not-tested": "Outside this observatory’s safe, unauthenticated test scope.",
};

const CSS = String.raw`
  :root {
    color-scheme: dark;
    --bg: #07100d;
    --panel: #0b1713;
    --panel-2: #10211b;
    --line: #1d3a30;
    --line-bright: #2b5949;
    --text: #e7f5ee;
    --muted: #91aa9f;
    --faint: #688177;
    --green: #63f2ab;
    --green-2: #1dc77b;
    --cyan: #61d9ee;
    --amber: #f2c96d;
    --red: #ff7d7d;
    --violet: #bc9cff;
    --radius: 14px;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    margin: 0;
    min-height: 100vh;
    color: var(--text);
    background:
      radial-gradient(circle at 80% -10%, rgba(33, 183, 116, .15), transparent 32rem),
      linear-gradient(rgba(99, 242, 171, .026) 1px, transparent 1px),
      linear-gradient(90deg, rgba(99, 242, 171, .026) 1px, transparent 1px),
      var(--bg);
    background-size: auto, 28px 28px, 28px 28px, auto;
    font-family: var(--sans);
    line-height: 1.55;
  }
  a { color: var(--green); text-decoration: none; }
  a:hover { color: #a2ffd0; }
  code, .mono { font-family: var(--mono); }
  code { color: #b8fbd6; }
  .shell { width: min(1240px, calc(100% - 32px)); margin: 0 auto; }
  .site-header {
    position: sticky;
    z-index: 20;
    top: 0;
    border-bottom: 1px solid rgba(43, 89, 73, .78);
    background: rgba(7, 16, 13, .9);
    backdrop-filter: blur(14px);
  }
  .header-inner { min-height: 68px; display: flex; align-items: center; gap: 28px; }
  .brand { display: flex; align-items: center; gap: 11px; font: 800 18px/1 var(--mono); color: var(--text); }
  .brand-mark { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--green-2); border-radius: 8px; color: var(--green); background: rgba(29, 199, 123, .09); box-shadow: inset 0 0 18px rgba(99,242,171,.06); }
  .brand em { color: var(--green); font-style: normal; }
  nav { display: flex; align-items: center; gap: 4px; margin-left: auto; }
  nav a { padding: 8px 10px; border-radius: 8px; color: var(--muted); font: 650 13px/1 var(--mono); }
  nav a:hover, nav a[aria-current="page"] { color: var(--text); background: var(--panel-2); }
  .scan-status { display: flex; align-items: center; gap: 7px; padding-left: 10px; color: var(--muted); font: 12px/1 var(--mono); }
  .scan-status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 10px var(--green); }
  main { padding: 52px 0 84px; }
  .hero { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(260px, .75fr); align-items: end; gap: 48px; padding: 34px 0 54px; }
  .eyebrow { margin: 0 0 14px; color: var(--green); font: 700 12px/1.2 var(--mono); letter-spacing: .13em; text-transform: uppercase; }
  h1 { max-width: 860px; margin: 0; font-size: clamp(40px, 6vw, 72px); line-height: 1.02; letter-spacing: -.055em; }
  h2 { margin: 0; font-size: clamp(22px, 3vw, 31px); line-height: 1.2; letter-spacing: -.025em; }
  h3 { margin: 0; font-size: 16px; line-height: 1.35; }
  .lede { max-width: 760px; margin: 22px 0 0; color: var(--muted); font-size: 17px; }
  .hero-note { border-left: 1px solid var(--line-bright); padding: 4px 0 4px 22px; color: var(--muted); font-size: 14px; }
  .hero-note strong { display: block; margin-bottom: 8px; color: var(--text); font: 700 12px/1.2 var(--mono); text-transform: uppercase; letter-spacing: .08em; }
  .section { margin-top: 48px; }
  .section-head { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 18px; }
  .section-head p { max-width: 700px; margin: 7px 0 0; color: var(--muted); }
  .text-link { white-space: nowrap; font: 650 13px/1.3 var(--mono); }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .stat { min-height: 132px; padding: 20px; border: 1px solid var(--line); border-radius: var(--radius); background: linear-gradient(145deg, rgba(16,33,27,.96), rgba(9,20,16,.96)); }
  .stat-label { color: var(--muted); font: 650 11px/1.3 var(--mono); letter-spacing: .07em; text-transform: uppercase; }
  .stat-value { display: block; margin-top: 19px; font: 760 clamp(28px, 4vw, 40px)/1 var(--mono); letter-spacing: -.05em; }
  .stat-sub { display: block; margin-top: 11px; color: var(--faint); font-size: 12px; }
  .panel { border: 1px solid var(--line); border-radius: var(--radius); background: rgba(11, 23, 19, .94); overflow: hidden; }
  .panel-pad { padding: 24px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th { padding: 12px 16px; color: var(--faint); background: rgba(16,33,27,.65); border-bottom: 1px solid var(--line); font: 650 11px/1.3 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
  td { padding: 15px 16px; border-bottom: 1px solid rgba(29,58,48,.68); vertical-align: top; font-size: 13px; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: rgba(99,242,171,.022); }
  .service-name { display: block; color: var(--text); font-weight: 700; }
  .service-origin { display: block; max-width: 360px; margin-top: 4px; color: var(--faint); font: 11px/1.45 var(--mono); overflow: hidden; text-overflow: ellipsis; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; }
  .badge, .state { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 3px 8px; border: 1px solid var(--line); border-radius: 999px; background: rgba(16,33,27,.8); color: #b8cec4; font: 650 11px/1.25 var(--mono); }
  .badge-accent { border-color: rgba(99,242,171,.35); color: var(--green); }
  .state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .state-observed { color: var(--cyan); border-color: rgba(97,217,238,.35); }
  .state-inferred { color: var(--violet); border-color: rgba(188,156,255,.35); }
  .state-tested-pass { color: var(--green); border-color: rgba(99,242,171,.35); }
  .state-tested-fail { color: var(--red); border-color: rgba(255,125,125,.38); }
  .state-unknown, .state-not-tested { color: var(--muted); }
  .muted { color: var(--muted); }
  .faint { color: var(--faint); }
  .numeric { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .filters { display: grid; grid-template-columns: minmax(180px, 2fr) repeat(4, minmax(120px, 1fr)) auto; gap: 9px; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); margin-bottom: 14px; }
  label { color: var(--muted); font: 650 11px/1.3 var(--mono); }
  input, select, button { font: inherit; }
  input, select { width: 100%; height: 40px; margin-top: 6px; padding: 0 11px; border: 1px solid var(--line); border-radius: 8px; outline: none; color: var(--text); background: #08130f; }
  input:focus, select:focus { border-color: var(--green-2); box-shadow: 0 0 0 3px rgba(29,199,123,.1); }
  button, .button { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 0 15px; border: 1px solid var(--green-2); border-radius: 8px; color: #03110b; background: var(--green); cursor: pointer; font: 750 12px/1 var(--mono); }
  button:hover, .button:hover { background: #95ffc8; color: #03110b; }
  .filter-action { align-self: end; }
  .pagination { display: flex; justify-content: flex-end; padding: 16px; border-top: 1px solid var(--line); }
  .pagination a { font: 650 12px/1.3 var(--mono); }
  .empty { padding: 44px 24px; text-align: center; color: var(--muted); }
  .detail-head { display: flex; align-items: start; justify-content: space-between; gap: 24px; }
  .detail-title h1 { font-size: clamp(34px, 5vw, 55px); }
  .detail-title .service-origin { max-width: 680px; margin-top: 13px; font-size: 13px; }
  .detail-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(250px, .8fr); gap: 18px; margin-top: 30px; }
  .facts { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 1px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--line); overflow: hidden; }
  .fact { min-height: 94px; padding: 18px; background: var(--panel); }
  .fact dt { margin: 0 0 9px; color: var(--faint); font: 650 10px/1.3 var(--mono); letter-spacing: .07em; text-transform: uppercase; }
  .fact dd { margin: 0; overflow-wrap: anywhere; }
  .endpoint { padding: 22px; border-bottom: 1px solid var(--line); }
  .endpoint:last-child { border-bottom: 0; }
  .endpoint-head { display: flex; align-items: start; gap: 11px; }
  .method { min-width: 48px; padding: 4px 7px; border-radius: 6px; color: #07100d; background: var(--green); text-align: center; font: 800 10px/1.2 var(--mono); }
  .endpoint-url { min-width: 0; overflow-wrap: anywhere; font: 650 13px/1.45 var(--mono); }
  .endpoint-meta { display: flex; flex-wrap: wrap; gap: 13px; margin: 13px 0 0 59px; color: var(--faint); font: 11px/1.4 var(--mono); }
  .offers { display: grid; gap: 8px; margin: 17px 0 0 59px; }
  .offer { padding: 14px; border: 1px solid var(--line); border-radius: 9px; background: rgba(7,16,13,.55); }
  .offer-top { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
  .price { margin-left: auto; color: var(--text); font: 760 13px/1.3 var(--mono); }
  .kv { display: grid; grid-template-columns: minmax(90px,.4fr) minmax(0,1.6fr); gap: 6px 14px; margin-top: 11px; font: 11px/1.45 var(--mono); }
  .kv dt { color: var(--faint); }
  .kv dd { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
  .risk-note { margin-top: 12px; padding: 10px 12px; border-left: 2px solid var(--amber); background: rgba(242,201,109,.05); color: #cfbd8f; font-size: 12px; }
  .security-list { display: grid; gap: 10px; }
  .security-item { padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: rgba(7,16,13,.5); }
  .security-item-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .security-item p { margin: 9px 0 0; color: var(--muted); font-size: 12px; }
  .security-item small { display: block; margin-top: 7px; color: var(--faint); font: 10px/1.45 var(--mono); }
  .source { padding: 13px 0; border-bottom: 1px solid var(--line); }
  .source:last-child { border-bottom: 0; }
  .source-kind { color: var(--text); font: 700 11px/1.4 var(--mono); }
  .source-url { display: block; margin-top: 4px; color: var(--faint); font: 10px/1.45 var(--mono); overflow-wrap: anywhere; }
  .timeline { position: relative; }
  .change { display: grid; grid-template-columns: 150px 14px minmax(0,1fr); gap: 17px; min-height: 96px; }
  .change-time { padding-top: 1px; color: var(--faint); font: 11px/1.5 var(--mono); text-align: right; }
  .change-track { position: relative; }
  .change-track::before { content: ""; position: absolute; left: 6px; top: 6px; bottom: -6px; width: 1px; background: var(--line); }
  .change:last-child .change-track::before { display: none; }
  .change-track::after { content: ""; position: absolute; left: 2px; top: 4px; width: 8px; height: 8px; border: 1px solid var(--green); border-radius: 50%; background: var(--bg); }
  .change-body { padding-bottom: 27px; }
  .change-body h3 a { color: var(--text); }
  .change-body p { margin: 7px 0 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .diff-old { color: #e59a9a; text-decoration: line-through; }
  .diff-new { color: #8fe8ba; }
  .concentration { height: 7px; margin-top: 7px; border-radius: 999px; background: #07100d; overflow: hidden; }
  .concentration span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--green-2), var(--cyan)); }
  .prose { max-width: 860px; }
  .prose h2 { margin: 48px 0 14px; }
  .prose h3 { margin: 27px 0 9px; }
  .prose p, .prose li { color: var(--muted); }
  .prose ul { padding-left: 22px; }
  .prose li { margin: 8px 0; }
  .callout { margin: 24px 0; padding: 18px 20px; border: 1px solid var(--line-bright); border-radius: 10px; background: rgba(16,33,27,.72); }
  .callout strong { color: var(--text); }
  .state-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; margin-top: 18px; }
  .state-definition { padding: 14px; border: 1px solid var(--line); border-radius: 9px; }
  .state-definition p { margin: 8px 0 0; font-size: 12px; }
  .submit-card { max-width: 720px; padding: 26px; }
  .submit-card form { display: grid; gap: 17px; margin-top: 24px; }
  .submit-card textarea { width: 100%; min-height: 90px; margin-top: 6px; padding: 11px; border: 1px solid var(--line); border-radius: 8px; outline: none; resize: vertical; color: var(--text); background: #08130f; font: inherit; }
  .submit-card textarea:focus { border-color: var(--green-2); box-shadow: 0 0 0 3px rgba(29,199,123,.1); }
  .notice { margin-bottom: 18px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 9px; font-size: 13px; }
  .notice-success { border-color: rgba(99,242,171,.4); color: #b8fbd6; background: rgba(99,242,171,.06); }
  .notice-error { border-color: rgba(255,125,125,.4); color: #ffc2c2; background: rgba(255,125,125,.06); }
  .notice-info { color: var(--muted); }
  footer { padding: 28px 0 42px; border-top: 1px solid var(--line); color: var(--faint); font-size: 12px; }
  .footer-inner { display: flex; justify-content: space-between; gap: 24px; }
  .footer-links { display: flex; gap: 16px; font-family: var(--mono); }
  @media (max-width: 980px) {
    .stats { grid-template-columns: repeat(2,minmax(0,1fr)); }
    .filters { grid-template-columns: repeat(2,minmax(0,1fr)); }
    .filters label:first-child { grid-column: span 2; }
    .detail-grid { grid-template-columns: 1fr; }
    .hero { grid-template-columns: 1fr; }
  }
  @media (max-width: 720px) {
    .shell { width: calc(100% - 22px); max-width: 1240px; }
    .header-inner { min-height: auto; padding: 13px 0; flex-wrap: wrap; }
    nav { order: 3; width: 100%; overflow-x: auto; margin: 0; }
    nav a { flex: 0 0 auto; }
    .scan-status { margin-left: auto; }
    main { padding-top: 30px; }
    .hero { gap: 28px; padding-top: 20px; }
    .stats { grid-template-columns: 1fr 1fr; }
    .stat { min-height: 112px; padding: 15px; }
    .filters { grid-template-columns: 1fr; }
    .filters label:first-child { grid-column: auto; }
    .section-head, .detail-head { align-items: start; flex-direction: column; }
    .facts { grid-template-columns: 1fr; }
    .endpoint-meta, .offers { margin-left: 0; }
    .change { grid-template-columns: 14px minmax(0,1fr); gap: 13px; }
    .change-time { grid-column: 2; grid-row: 1; padding-bottom: 5px; text-align: left; }
    .change-track { grid-column: 1; grid-row: 1 / span 2; }
    .change-body { grid-column: 2; grid-row: 2; }
    .state-grid { grid-template-columns: 1fr; }
    .footer-inner { flex-direction: column; }
  }
  @media (max-width: 480px) {
    .header-inner { gap: 12px; }
    .stats { grid-template-columns: 1fr; }
    h1 { font-size: clamp(36px, 11vw, 44px); overflow-wrap: anywhere; }
    .eyebrow { overflow-wrap: anywhere; }
  }
`;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function text(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function row(value: unknown): DataRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DataRow : {};
}

function rows(value: unknown): DataRow[] {
  return Array.isArray(value) ? value.filter((item): item is DataRow => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function dataRows(payload: unknown): DataRow[] {
  const object = row(payload);
  return rows(object.data);
}

function pagination(payload: unknown): DataRow {
  return row(row(payload).pagination);
}

function safeHref(value: unknown, fallback = "#"): string {
  const candidate = text(value, "");
  if (candidate.startsWith("/") && !candidate.startsWith("//")) return escapeHtml(candidate);
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? escapeHtml(parsed.toString()) : fallback;
  } catch {
    return fallback;
  }
}

function internalServiceHref(id: unknown): string {
  return `/services/${encodeURIComponent(text(id, "unknown"))}`;
}

function formatInteger(value: unknown): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number(value));
}

function formatPercent(value: unknown): string {
  return `${(number(value) * 100).toFixed(number(value) > 0 && number(value) < .01 ? 2 : 1)}%`;
}

function formatDate(value: unknown): string {
  const raw = text(value, "");
  if (!raw) return "Not yet observed";
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) return raw;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC";
}

function shortDate(value: unknown): string {
  const raw = text(value, "");
  if (!raw) return "unknown time";
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) return raw;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date) + " UTC";
}

function truncate(value: unknown, length = 48): string {
  const raw = text(value, "");
  return raw.length > length ? `${raw.slice(0, Math.max(1, length - 1))}…` : raw;
}

function activeAttr(current: string, key: string): string {
  return current === key ? ' aria-current="page"' : "";
}

function layout(title: string, description: string, current: string, content: string): string {
  const fullTitle = title === "mpp.ninja" ? title : `${title} · mpp.ninja`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <title>${escapeHtml(fullTitle)}</title>
  <style>${CSS}</style>
</head>
<body>
  <header class="site-header">
    <div class="shell header-inner">
      <a class="brand" href="/" aria-label="mpp.ninja home"><span class="brand-mark">M</span><span>mpp<em>.ninja</em></span></a>
      <nav aria-label="Primary navigation">
        <a href="/"${activeAttr(current, "dashboard")}>Dashboard</a>
        <a href="/services"${activeAttr(current, "services")}>Services</a>
        <a href="/implementations"${activeAttr(current, "implementations")}>Ecosystem</a>
        <a href="/changes"${activeAttr(current, "changes")}>Changes</a>
        <a href="/methodology"${activeAttr(current, "methodology")}>Methodology</a>
        <a href="/submit"${activeAttr(current, "submit")}>Submit</a>
      </nav>
      <span class="scan-status">safe scan</span>
    </div>
  </header>
  <main><div class="shell">${content}</div></main>
  <footer><div class="shell footer-inner">
    <span>Harmless, unauthenticated observations only. No payments, credentials, fuzzing, or state changes.</span>
    <span class="footer-links"><a href="/api/stats">JSON API</a><a href="https://github.com/pierce403/mpp.ninja" rel="noreferrer">Source</a></span>
  </div></footer>
</body>
</html>`;
}

function badge(value: unknown, accent = false): string {
  return `<span class="badge${accent ? " badge-accent" : ""}">${escapeHtml(text(value))}</span>`;
}

function stateBadge(value: unknown): string {
  const state = text(value, "unknown").toLowerCase();
  const knownState = STATE_LABELS[state] ? state : "unknown";
  return `<span class="state state-${escapeHtml(knownState)}" title="${escapeHtml(STATE_EXPLANATIONS[knownState])}">${escapeHtml(STATE_LABELS[knownState])}</span>`;
}

function serviceTable(payload: unknown, compact = false): string {
  const services = dataRows(payload);
  if (services.length === 0) return `<div class="panel"><div class="empty">No indexed services match this view.</div></div>`;
  return `<div class="panel table-wrap"><table>
    <thead><tr><th>Service</th><th>Payment methods</th><th>Implementation</th><th>Endpoints</th>${compact ? "" : "<th>Last seen</th>"}</tr></thead>
    <tbody>${services.map((service) => {
      const methods = stringList(service.paymentMethods ?? service.payment_methods);
      const implementation = text(service.implementation, "unknown");
      const confidence = number(service.implementation_confidence);
      return `<tr>
        <td><a class="service-name" href="${internalServiceHref(service.id)}">${escapeHtml(text(service.name, "Unnamed service"))}</a><span class="service-origin">${escapeHtml(text(service.origin ?? service.service_url))}</span></td>
        <td><div class="badges">${methods.length ? methods.map((method) => badge(method, true)).join("") : badge("not observed")}</div></td>
        <td>${badge(implementation)}${confidence > 0 ? `<div class="faint mono" style="margin-top:6px">${escapeHtml(Math.round(confidence * 100))}% confidence</div>` : ""}</td>
        <td class="numeric">${escapeHtml(formatInteger(service.endpoint_count))}${number(service.failed_checks) > 0 ? `<div style="margin-top:6px">${stateBadge("tested-fail")}</div>` : ""}</td>
        ${compact ? "" : `<td class="faint mono">${escapeHtml(shortDate(service.last_seen))}</td>`}
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function changesTimeline(payload: unknown, limit?: number): string {
  const changes = dataRows(payload).slice(0, limit ?? Number.POSITIVE_INFINITY);
  if (changes.length === 0) return `<div class="panel"><div class="empty">No historical changes recorded yet.</div></div>`;
  return `<div class="timeline">${changes.map((change) => {
    const oldValue = text(change.old_value, "");
    const newValue = text(change.new_value, "");
    return `<article class="change">
      <time class="change-time" datetime="${escapeHtml(text(change.changed_at, ""))}">${escapeHtml(shortDate(change.changed_at))}</time>
      <div class="change-track" aria-hidden="true"></div>
      <div class="change-body">
        <h3><a href="${internalServiceHref(change.service_id)}">${escapeHtml(text(change.service_name, text(change.service_id)))}</a> <span class="badge">${escapeHtml(text(change.change_type, "changed"))}</span></h3>
        <p><code>${escapeHtml(text(change.field_name, "property"))}</code>${oldValue ? `: <span class="diff-old">${escapeHtml(truncate(oldValue, 120))}</span>` : ""}${newValue ? ` → <span class="diff-new">${escapeHtml(truncate(newValue, 120))}</span>` : ""}</p>
        ${change.evidence ? `<p class="faint">Evidence: ${escapeHtml(change.evidence)}</p>` : ""}
      </div>
    </article>`;
  }).join("")}</div>`;
}

export function renderDashboard(statsInput: unknown, servicesInput: unknown = {}, changesInput: unknown = {}): string {
  const stats = row(statsInput);
  const lastActivity = stats.last_observation ?? stats.last_discovery;
  const content = `
    <section class="hero">
      <div>
        <p class="eyebrow">Global Machine Payments Protocol intelligence</p>
        <h1>See the public MPP attack surface.</h1>
        <p class="lede">A continuously updated map of public MPP services, payment configurations, implementation signals, and evidence-scoped security properties.</p>
      </div>
      <aside class="hero-note"><strong>Scanner boundary</strong>Public discovery documents, <code>GET</code>/<code>HEAD</code>, legitimate <code>402</code> challenges, redirects, and transport metadata. Never payments or signed credentials.</aside>
    </section>
    <section class="stats" aria-label="Global index statistics">
      <article class="stat"><span class="stat-label">Indexed services</span><strong class="stat-value">${escapeHtml(formatInteger(stats.services))}</strong><span class="stat-sub">${escapeHtml(formatInteger(stats.probed_services))} safely probed · ${escapeHtml(formatInteger(stats.challenge_services))} runtime MPP</span></article>
      <article class="stat"><span class="stat-label">Public endpoints</span><strong class="stat-value">${escapeHtml(formatInteger(stats.endpoints))}</strong><span class="stat-sub">${escapeHtml(formatInteger(stats.offers))} payment offers</span></article>
      <article class="stat"><span class="stat-label">Payment methods</span><strong class="stat-value">${escapeHtml(formatInteger(stats.payment_methods))}</strong><span class="stat-sub">Across observable configurations</span></article>
      <article class="stat"><span class="stat-label">Retained observations</span><strong class="stat-value">${escapeHtml(formatInteger(stats.observations))}</strong><span class="stat-sub">Latest: ${escapeHtml(shortDate(lastActivity))}</span></article>
    </section>
    ${number(stats.tested_fail) > 0 ? `<div class="callout"><strong>${escapeHtml(formatInteger(stats.tested_fail))} tested-fail result${number(stats.tested_fail) === 1 ? "" : "s"}</strong> are recorded. Each applies only to its named harmless test and observation; review service evidence before drawing conclusions.</div>` : ""}
    <section class="section">
      <div class="section-head"><div><p class="eyebrow">Index</p><h2>Recently observed services</h2></div><a class="text-link" href="/services">Explore all services →</a></div>
      ${serviceTable(servicesInput, true)}
    </section>
    <section class="section">
      <div class="section-head"><div><p class="eyebrow">History</p><h2>Recent ecosystem changes</h2><p>Changes are comparisons between bounded public observations, not claims about private deployment state.</p></div><a class="text-link" href="/changes">Full timeline →</a></div>
      ${changesTimeline(changesInput, 8)}
    </section>`;
  return layout("mpp.ninja", "Global security observatory for public Machine Payments Protocol services.", "dashboard", content);
}

export function renderServices(payload: unknown, currentUrl?: URL): string {
  const search = currentUrl?.searchParams ?? new URLSearchParams();
  const total = number(pagination(payload).total);
  const option = (value: string, label: string, key: string): string => `<option value="${escapeHtml(value)}"${search.get(key) === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const nextCursor = text(pagination(payload).nextCursor, "");
  const nextParams = new URLSearchParams(search);
  if (nextCursor) nextParams.set("cursor", nextCursor);
  const content = `
    <section class="detail-head">
      <div class="detail-title"><p class="eyebrow">Public index</p><h1>Services</h1><p class="lede">${escapeHtml(formatInteger(total))} normalized services with source provenance, payment configuration, and bounded observations.</p></div>
      <a class="button" href="/submit">Submit a service</a>
    </section>
    <section class="section">
      <form class="filters" method="get" action="/services">
        <label>Search<input type="search" name="q" maxlength="120" value="${escapeHtml(search.get("q") ?? "")}" placeholder="Name, description, or origin"></label>
        <label>Payment method<input name="method" maxlength="40" value="${escapeHtml(search.get("method") ?? "")}" placeholder="tempo"></label>
        <label>Chain<input name="chain" maxlength="80" value="${escapeHtml(search.get("chain") ?? "")}" placeholder="Chain ID"></label>
        <label>Implementation<select name="implementation">${option("", "Any", "implementation")}${option("mppx", "mppx", "implementation")}${option("mpp-rs", "mpp-rs", "implementation")}${option("mpp-proxy", "Cloudflare mpp-proxy", "implementation")}${option("custom", "Custom", "implementation")}${option("unknown", "Unknown", "implementation")}</select></label>
        <label>Evidence state<select name="security">${option("", "Any", "security")}${Object.entries(STATE_LABELS).map(([value,label]) => option(value,label,"security")).join("")}</select></label>
        <button class="filter-action" type="submit">Filter</button>
      </form>
      ${serviceTable(payload)}
      ${nextCursor ? `<div class="pagination"><a href="/services?${escapeHtml(nextParams.toString())}">Next page →</a></div>` : ""}
    </section>`;
  return layout("Services", "Search and filter the public MPP service index.", "services", content);
}

function renderOffer(offerInput: unknown): string {
  const offer = row(offerInput);
  const session = row(offer.session);
  const method = text(offer.method, "unknown");
  const amount = text(offer.amount, "amount unknown");
  const currency = text(offer.currency, "currency unknown");
  const recipient = text(offer.recipient, "not observed");
  const chain = text(offer.chainId ?? offer.chain_id, "not observed");
  const sessionEntries = Object.entries(session).filter(([,value]) => ["string", "number", "boolean"].includes(typeof value)).slice(0, 12);
  const deposit = numericField(session.suggestedDeposit ?? session.deposit ?? session.depositAmount);
  const window = numericField(session.authorizationWindow ?? session.window ?? session.windowAmount);
  const unitPrice = numericField(offer.amount);
  const units = numericField(session.maxUnits ?? session.units);
  const metrics: string[] = [];
  if (deposit !== null && window !== null && window > 0) metrics.push(`Observed deposit / authorization window: ${formatRatio(deposit / window)}`);
  if (window !== null && unitPrice !== null && units !== null) metrics.push(`Observable authorization exposure: ${Math.max(0, window - unitPrice * units).toLocaleString("en-US", { maximumFractionDigits: 8 })}`);
  return `<div class="offer">
    <div class="offer-top">${badge(method, true)}${badge(text(offer.intent, "charge"))}${badge(text(offer.sourceType ?? offer.source_type, "unknown source"))}<strong class="price">${escapeHtml(amount)} ${escapeHtml(currency)}</strong></div>
    <dl class="kv"><dt>Recipient</dt><dd title="${escapeHtml(recipient)}">${escapeHtml(truncate(recipient, 88))}</dd><dt>Chain</dt><dd>${escapeHtml(chain)}</dd><dt>Unit type</dt><dd>${escapeHtml(text(offer.unitType ?? offer.unit_type, "not observed"))}</dd>${sessionEntries.map(([key,value]) => `<dt>Session · ${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
    <div class="risk-note">${metrics.length ? `${metrics.map(escapeHtml).join(" · ")} <span class="faint">Derived only from fields in this public offer.</span>` : "Economic exposure: unknown — the public observation does not contain enough session or authorization inputs to calculate it."}</div>
  </div>`;
}

function numericField(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return null;
  const significant = raw.replace(/^0+|\.|0+$/g, "");
  if (significant.length > 15) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}×`;
}

function renderEndpoint(endpoint: DataRow): string {
  const offers = rows(endpoint.offers);
  const offerPage = row(endpoint.offerPagination);
  const offerTotal = number(offerPage.total);
  const status = endpoint.last_status === null || endpoint.last_status === undefined ? "not probed" : String(endpoint.last_status);
  return `<article class="endpoint">
    <div class="endpoint-head"><span class="method">${escapeHtml(text(endpoint.http_method, "GET"))}</span><div><div class="endpoint-url">${escapeHtml(text(endpoint.url))}</div>${endpoint.description ? `<div class="muted" style="margin-top:6px">${escapeHtml(endpoint.description)}</div>` : ""}</div></div>
    <div class="endpoint-meta"><span>Status: ${escapeHtml(status)}</span><span>TLS: ${escapeHtml(text(endpoint.tls_state, "not-tested"))}</span><span>Redirects: ${escapeHtml(text(endpoint.redirect_count, "unknown"))}</span><span>Challenge: ${escapeHtml(text(endpoint.challenge_format, "not observed"))}</span><span>Last probe: ${escapeHtml(shortDate(endpoint.last_probe_at))}</span></div>
    <div class="offers">${offers.length ? offers.map(renderOffer).join("") : `<div class="offer muted">No normalized payment offer observed for this endpoint.</div>`}${offerPage.truncated ? `<div class="offer muted">Showing ${escapeHtml(formatInteger(offers.length))} of ${escapeHtml(formatInteger(offerTotal))} active offers. Use the paginated endpoints API for bounded machine-readable inspection.</div>` : ""}</div>
  </article>`;
}

export function renderServiceDetail(serviceInput: unknown): string {
  const service = row(serviceInput);
  const endpoints = rows(service.endpoints);
  const security = rows(service.security);
  const sources = rows(service.sources);
  const changes = rows(service.changes);
  const categories = stringList(service.categories);
  const tags = stringList(service.tags);
  const evidence = stringList(service.fingerprintEvidence ?? service.fingerprint_evidence_json);
  const endpointPage = row(service.endpointPagination);
  const endpointTotal = number(endpointPage.total);
  const securityPage = row(service.securityPagination);
  const sourcePage = row(service.sourcePagination);
  const changePage = row(service.changePagination);
  const implementation = text(service.implementation, "unknown");
  const confidence = number(service.implementation_confidence);
  const content = `
    <section class="detail-head">
      <div class="detail-title"><p class="eyebrow">Service record</p><h1>${escapeHtml(text(service.name, "Unnamed service"))}</h1><a class="service-origin" href="${safeHref(service.service_url)}" rel="noreferrer">${escapeHtml(text(service.service_url))}</a></div>
      <div class="badges">${badge(text(service.status, "unknown"), true)}${categories.map((value) => badge(value)).join("")}</div>
    </section>
    ${service.description ? `<p class="lede">${escapeHtml(service.description)}</p>` : ""}
    <div class="detail-grid">
      <div>
        <dl class="facts">
          <div class="fact"><dt>Implementation fingerprint</dt><dd>${badge(implementation, true)} <span class="muted mono">${confidence > 0 ? `${Math.round(confidence * 100)}% confidence` : "no confident attribution"}</span></dd></div>
          <div class="fact"><dt>Fingerprint evidence</dt><dd class="muted">${evidence.length ? evidence.map((value) => escapeHtml(value)).join(" · ") : "No implementation-specific public signal observed."}</dd></div>
          <div class="fact"><dt>First seen</dt><dd class="mono">${escapeHtml(formatDate(service.first_seen))}</dd></div>
          <div class="fact"><dt>Last seen</dt><dd class="mono">${escapeHtml(formatDate(service.last_seen))}</dd></div>
          <div class="fact"><dt>Origin</dt><dd class="mono">${escapeHtml(text(service.origin))}</dd></div>
          <div class="fact"><dt>Tags</dt><dd><div class="badges">${tags.length ? tags.map((value) => badge(value)).join("") : `<span class="muted">None advertised</span>`}</div></dd></div>
        </dl>
        <section class="section">
          <div class="section-head"><div><p class="eyebrow">Payment surface</p><h2>${escapeHtml(formatInteger(endpointTotal || endpoints.length))} endpoint${(endpointTotal || endpoints.length) === 1 ? "" : "s"}</h2><p>Configuration combines catalog, OpenAPI, and public challenge evidence. Runtime <code>402</code> observations are time-specific.</p>${endpointPage.nextCursor ? `<p class="muted">This bounded detail view shows ${escapeHtml(formatInteger(endpoints.length))} endpoints. Continue with <a href="/api/services/${encodeURIComponent(text(service.id))}?cursor=${encodeURIComponent(text(endpointPage.nextCursor))}">the next API page</a> or <a href="/api/endpoints?service=${encodeURIComponent(text(service.id))}">the endpoint index</a>.</p>` : ""}</div><a class="text-link" href="/api/services/${encodeURIComponent(text(service.id))}">JSON record →</a></div>
          <div class="panel">${endpoints.length ? endpoints.map(renderEndpoint).join("") : `<div class="empty">No endpoints have been normalized for this service.</div>`}</div>
        </section>
        <section class="section">
          <div class="section-head"><div><p class="eyebrow">Evidence model</p><h2>Security properties</h2><p>Every result names its evidence state. Unknown and not tested never mean secure.</p></div></div>
          <div class="security-list">${security.length ? security.map((property) => `<article class="security-item"><div class="security-item-head"><h3 class="mono">${escapeHtml(text(property.property_key))}</h3>${stateBadge(property.state)}</div><p>${escapeHtml(text(property.evidence, "No evidence note recorded."))}</p><small>Basis: ${escapeHtml(text(property.basis, "unspecified"))}${property.advisory_ref ? ` · Prior art: ${escapeHtml(property.advisory_ref)}` : ""} · ${escapeHtml(formatDate(property.observed_at))}</small></article>`).join("") : `<div class="panel"><div class="empty">No security properties recorded yet. This does not imply a secure result.</div></div>`}${securityPage.truncated ? `<div class="panel"><div class="empty">Showing a bounded ${escapeHtml(formatInteger(security.length))} of ${escapeHtml(formatInteger(securityPage.total))} security-property records.</div></div>` : ""}</div>
        </section>
      </div>
      <aside>
        <div class="panel panel-pad"><p class="eyebrow">Provenance</p><h3>${escapeHtml(formatInteger(number(sourcePage.total) || sources.length))} discovery source${(number(sourcePage.total) || sources.length) === 1 ? "" : "s"}</h3><div style="margin-top:13px">${sources.length ? sources.map((source) => `<div class="source"><span class="source-kind">${escapeHtml(text(source.source_kind))}</span><a class="source-url" href="${safeHref(source.source_url)}" rel="noreferrer">${escapeHtml(text(source.source_url))}</a><span class="source-url">Seen ${escapeHtml(shortDate(source.first_seen))} → ${escapeHtml(shortDate(source.last_seen))}</span></div>`).join("") : `<p class="muted">No provenance records.</p>`}${sourcePage.truncated ? `<p class="muted">The response is capped at ${escapeHtml(formatInteger(sourcePage.limit))} source records.</p>` : ""}</div></div>
        <div class="panel panel-pad" style="margin-top:18px"><p class="eyebrow">Interpretation</p><p class="muted" style="margin:0">Fingerprints identify observable implementation signals, not an exact deployed version. Public advisories and research classes are prior art unless direct applicability is established.</p></div>
      </aside>
    </div>
    <section class="section"><div class="section-head"><div><p class="eyebrow">History</p><h2>Service changes</h2>${changePage.truncated ? `<p>Showing the latest ${escapeHtml(formatInteger(changes.length))} of ${escapeHtml(formatInteger(changePage.total))} changes. Continue in the <a href="/changes?service=${encodeURIComponent(text(service.id))}">changes API view</a>.</p>` : ""}</div></div>${changesTimeline({ data: changes }, 25)}</section>`;
  return layout(text(service.name, "Service"), `Evidence-scoped MPP observatory record for ${text(service.name, "a public service")}.`, "services", content);
}

export function renderImplementations(payload: unknown): string {
  const implementations = dataRows(payload);
  const total = number(row(payload).totalServices);
  const content = `
    <section class="hero">
      <div><p class="eyebrow">Ecosystem concentration</p><h1>Implementation signals</h1><p class="lede">Conservative fingerprints from public headers, challenges, and discovery metadata across ${escapeHtml(formatInteger(total))} indexed services.</p></div>
      <aside class="hero-note"><strong>Attribution boundary</strong>A fingerprint is a probabilistic observation, not proof of source code, version, configuration, vulnerability, or advisory applicability.</aside>
    </section>
    <section class="section">
      <div class="panel table-wrap"><table><thead><tr><th>Implementation</th><th>Services</th><th>Concentration</th><th>Average confidence</th><th>High-confidence records</th></tr></thead><tbody>
      ${implementations.length ? implementations.map((item) => {
        const concentration = Math.max(0, Math.min(1, number(item.concentration)));
        return `<tr><td>${badge(text(item.implementation, "unknown"), true)}</td><td class="numeric">${escapeHtml(formatInteger(item.services))}</td><td style="min-width:180px"><span class="numeric">${escapeHtml(formatPercent(concentration))}</span><div class="concentration"><span style="width:${escapeHtml((concentration * 100).toFixed(3))}%"></span></div></td><td class="numeric">${escapeHtml(formatPercent(item.average_confidence))}</td><td class="numeric">${escapeHtml(formatInteger(item.high_confidence))}</td></tr>`;
      }).join("") : `<tr><td colspan="5" class="empty">No implementation observations yet.</td></tr>`}
      </tbody></table></div>
    </section>
    <section class="section prose"><h2>How to read concentration</h2><p>Concentration describes the share of indexed service records assigned to a fingerprint category. It is sensitive to discovery coverage and unknown fingerprints. It does not establish shared infrastructure, shared operators, or a monoculture vulnerability.</p><div class="callout"><strong>Unknown is useful data.</strong> The observatory prefers an unknown result over an attribution unsupported by observable evidence.</div></section>`;
  return layout("Ecosystem", "Conservative MPP implementation fingerprint and ecosystem concentration data.", "implementations", content);
}

export function renderChanges(payload: unknown): string {
  const total = number(pagination(payload).total);
  const content = `<section class="detail-head"><div class="detail-title"><p class="eyebrow">Observation history</p><h1>Recent changes</h1><p class="lede">${escapeHtml(formatInteger(total))} recorded differences in endpoints, recipients, prices, chains, challenge formats, transport metadata, and fingerprints.</p></div></section><section class="section">${changesTimeline(payload)}</section>`;
  return layout("Recent changes", "Timeline of observed changes across public MPP services.", "changes", content);
}

export function renderMethodology(): string {
  const definitions = Object.entries(STATE_LABELS).map(([state,label]) => `<div class="state-definition">${stateBadge(state)}<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(STATE_EXPLANATIONS[state])}</p></div>`).join("");
  const content = `
    <section class="hero"><div><p class="eyebrow">Evidence before conclusions</p><h1>Security methodology</h1><p class="lede">A deliberately bounded way to observe a payment ecosystem without making payments, holding credentials, or changing remote state.</p></div><aside class="hero-note"><strong>Core rule</strong>Untested does not mean secure. A passed check applies only to the exact property, endpoint, evidence, and observation time named in the record.</aside></section>
    <article class="prose">
      <h2>Discovery and normalization</h2>
      <p>The index combines public service catalogs, MPPScan/Merit listings, advertised OpenAPI or MPP discovery metadata, and manually submitted public URLs. Each normalized record retains its source URL and first/last-seen timestamps. A runtime <code>402</code> challenge is treated as time-specific evidence; catalog and OpenAPI declarations remain advertised configuration.</p>
      <h2>Safe probe boundary</h2>
      <p>Probes are limited to harmless, unauthenticated HTTP: advertised discovery documents, <code>GET</code>/<code>HEAD</code>, legitimate <code>402 Payment Required</code> responses, bounded redirects, and TLS/HTTP metadata. The scanner does not pay, sign credentials, replay authorizations, fuzz inputs, exploit suspected bugs, or intentionally change remote state.</p>
      <ul><li>Targets are deduplicated and processed with per-origin rate limits, jitter, timeouts, redirect limits, bounded response sizes, and retry backoff.</li><li>SSRF defenses reject localhost, private and reserved IPv4, link-local and private IPv6, cloud metadata addresses, DNS rebinding, and every target or redirect outside the normalized service hostname.</li><li>Authorization, cookies, payment credentials, secrets, and sensitive headers are redacted before observations are persisted or returned.</li><li>Redacted R2 observations expire after 30 days; D1 retains normalized summaries and body digests while bounded cleanup preserves current authority and the change timeline.</li></ul>
      <h2>Evidence states</h2>
      <div class="state-grid">${definitions}</div>
      <h2>Implementation fingerprints</h2>
      <p>Fingerprint categories — <code>mppx</code>, <code>mpp-rs</code>, Cloudflare <code>mpp-proxy</code>, custom, and unknown — require explicit public signals. Each record carries a confidence score and evidence list. Fingerprints do not establish an exact version or prove that a public advisory applies.</p>
      <h2>Economic security</h2>
      <p>The model tracks authorization/delivery/settlement mismatch, per-request price/debit mismatch, concurrency and single-winner behavior, replay and idempotency scope, channel lifecycle binding, fee-payer/cosigner behavior, and payment-method fallback as separate research classes. Public advisories and prior research inform what evidence to preserve; applicability remains unknown unless direct public evidence establishes it.</p>
      <p>For session or streaming offers, ratios and authorization-exposure metrics are shown only when the required numeric inputs appear in public metadata or a challenge. Otherwise the value is explicitly unknown. A ratio is descriptive evidence, not a vulnerability verdict.</p>
      <h2>What this observatory cannot establish</h2>
      <p>Passive public probing cannot verify settlement correctness, delivery accounting, credential replay resistance, concurrency safety, database transaction boundaries, private code versions, internal topology, or controls that require a valid payment session. Those properties remain <em>unknown</em> or <em>not tested</em>, not passed.</p>
    </article>`;
  return layout("Methodology", "Scope, safety boundary, evidence states, and limitations of the MPP observatory.", "methodology", content);
}

export function renderSubmissionForm(resultInput?: RenderResult): string {
  const result = resultInput ?? {};
  const tone = result.tone === "success" || result.tone === "error" ? result.tone : "info";
  const notice = result.message ? `<div class="notice notice-${tone}" role="status"><strong>${escapeHtml(result.title ?? (tone === "success" ? "Submission queued" : tone === "error" ? "Submission rejected" : "Submission status"))}</strong><br>${escapeHtml(result.message)}${result.normalizedUrl ? `<br><code>${escapeHtml(result.normalizedUrl)}</code>` : ""}</div>` : "";
  const content = `
    <section class="detail-head"><div class="detail-title"><p class="eyebrow">Expand the public index</p><h1>Submit a service</h1><p class="lede">Submit a public HTTPS service or discovery URL. Duplicate URLs are merged; accepted submissions schedule only the observatory’s harmless discovery workflow.</p></div></section>
    <section class="section"><div class="panel submit-card">${notice}<h2>Public service URL</h2>
      <form method="post" action="/api/submissions">
        <label>Public HTTP(S) URL<input required type="url" name="url" inputmode="url" maxlength="2048" placeholder="https://api.example.com/" value="${escapeHtml(result.normalizedUrl ?? "")}"></label>
        <label>Public source or context <span class="faint">(optional)</span><textarea name="sourceNote" maxlength="500" placeholder="Where is this service publicly advertised?"></textarea></label>
        <div><button type="submit">Validate and queue</button></div>
      </form>
      <div class="callout"><strong>Submission is not authorization for active testing.</strong> The scanner validates the public destination, blocks private networks, and performs only bounded unauthenticated discovery.</div>
    </div></section>`;
  return layout("Submit a service", "Submit a public MPP service for safe, unauthenticated discovery.", "submit", content);
}

export function renderNotFound(): string {
  return layout("Not found", "The requested observatory page was not found.", "", `<section class="hero"><div><p class="eyebrow">404</p><h1>Record not found.</h1><p class="lede">The service or page may not be indexed, or its identifier may have changed.</p><p style="margin-top:25px"><a class="button" href="/services">Browse services</a></p></div></section>`);
}
