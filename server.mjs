// JoinHub — multi-client Meta ads → landing → Telegram join tracker.
// Sirf REAL channel joins Meta ko (Conversions API) bheje jate hain, taaki Meta
// real joins ke liye optimize kare. Har client ka apna pixel + token + channel.
// Zero dependencies: Node.js 18+ chahiye.
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, '.env'));

const CFG = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  adminKey: process.env.ADMIN_PASSWORD || process.env.DASHBOARD_KEY || 'change-me-123',
  tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
  linkTtlMin: Number(process.env.INVITE_LINK_TTL_MINUTES || 120),
  autoApprove: (process.env.AUTO_APPROVE || 'true') === 'true',
  welcome: process.env.WELCOME_MESSAGE || '',
  metaVersion: process.env.META_API_VERSION || 'v23.0',
};
const DEMO = !CFG.tgToken;
const ROOT = __dirname;                      // sab files flat root me (landing1..6.html, dashboard.html)
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
// Optional free persistent DB (Upstash Redis REST) — taaki Render sleep/redeploy par data na jaye
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UP_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const useUpstash = !!(UP_URL && UP_TOK);
async function upstash(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: `Bearer ${UP_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
async function loadDbRemote() { try { const v = await upstash(['GET', 'joinhub_db']); if (v) { db = { ...db, ...JSON.parse(v) }; console.log('  DB: Upstash se load hua'); } } catch (e) { console.error('upstash load:', e.message); } }
async function saveDbRemote() { try { await upstash(['SET', 'joinhub_db', JSON.stringify(db)]); } catch (e) { console.error('upstash save:', e.message); } }

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- tiny JSON database ----------
let db = { clients: {}, visitors: {}, variantShown: {}, tgOffset: 0, tgUsers: {}, channels: {}, settings: {}, pending: {}, otherJoins: {} };
try { if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (e) { console.error('db read failed', e.message); }
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); } catch (e) {}
    if (useUpstash) saveDbRemote();
  }, 400);
}
setInterval(() => {
  const cutoff = Date.now() - 30 * 864e5;
  for (const [id, v] of Object.entries(db.visitors)) if (!v.joinedAt && v.createdAt < cutoff) delete db.visitors[id];
  save();
}, 6 * 3600e3).unref();

// ---------- helpers ----------
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|preview|headless|phantom|selenium|puppeteer|playwright|python|curl|wget|axios|node-fetch|go-http|okhttp|java\/|libwww|httpclient/i;
const sha256 = (s) => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');
const newId = () => crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || ('c' + Date.now().toString(36));
const SOURCES = ['instagram', 'facebook', 'other'];
const normSource = (s) => { s = (s || 'other').toLowerCase(); if (s.includes('insta') || s === 'ig') return 'instagram'; if (s.includes('face') || s === 'fb') return 'facebook'; return SOURCES.includes(s) ? s : 'other'; };
// utm_source ho to wahi; warna referer (Instagram/Facebook) se auto-detect — taaki chhota link bhi source pakde
function detectSource(url, req) {
  let s = normSource(url.searchParams.get('utm_source'));
  if (s === 'other') {
    const r = (req.headers['referer'] || req.headers['referrer'] || '').toLowerCase();
    if (r.includes('instagram') || r.includes('ig.')) s = 'instagram';
    else if (r.includes('facebook') || r.includes('fb.') || r.includes('fb_')) s = 'facebook';
  }
  return s;
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function clientIp(req) {
  return (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim().replace(/^::ffff:/, '');
}
function send(res, code, body, headers = {}) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(body); }
function json(res, code, obj) { send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json' }); }
function readBody(req) { return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e5) req.destroy(); }); req.on('end', () => resolve(d)); }); }
const okKey = (url) => (url.searchParams.get('key') || '') === CFG.adminKey;
const baseUrl = (req) => CFG.publicUrl || (`${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`);
// editable settings (dashboard se badalti hain, warna env/default)
function settings() {
  const s = db.settings || {};
  return {
    welcome: s.welcome !== undefined ? s.welcome : CFG.welcome,
    autoApprove: s.autoApprove !== undefined ? s.autoApprove : CFG.autoApprove,
    linkTtlMin: s.linkTtlMin !== undefined ? Number(s.linkTtlMin) : CFG.linkTtlMin,
  };
}

// ---------- landing rotation ----------
function variants() {
  try { return fs.readdirSync(ROOT).filter((f) => /^landing\d+\.html$/.test(f)).map((f) => f.replace(/\.html$/, '')).sort(); } catch { return []; }
}
function pickVariant(clientId) {
  const list = variants(); if (!list.length) return null;
  const shown = db.variantShown[clientId] || (db.variantShown[clientId] = {});
  list.sort((a, b) => (shown[a] || 0) - (shown[b] || 0));
  return list[0];
}
function renderLanding(variant, vid, client, cid) {
  let html = fs.readFileSync(path.join(ROOT, variant + '.html'), 'utf8');
  const joinUrl = vid ? `/join?vid=${vid}` : '#';
  const title = client?.landingTitle || client?.channelTitle || client?.name || 'हमारा Telegram चैनल';
  html = html.replaceAll('{{JOIN_URL}}', joinUrl).replaceAll('{{CHANNEL_TITLE}}', esc(title));
  // DP: manual URL > channel ki apni photo (auto, /dp proxy se — token hidden)
  const manualDp = (client?.dpUrl && /^https:\/\/[^'"()\s<>]+$/i.test(client.dpUrl)) ? client.dpUrl : '';
  const dpSrc = manualDp || ((client?.photoFileId && cid && !DEMO) ? `/dp?c=${encodeURIComponent(cid)}` : '');
  const dp = dpSrc ? `<style>.logo{background-image:url("${dpSrc}")!important;background-size:cover!important;background-position:center!important;color:transparent!important;font-size:0!important}</style>` : '';
  html = html.replace('</head>', dp + '</head>');
  const pixel = client?.pixel ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${esc(client.pixel)}');fbq('track','PageView');</script>` : '';
  const tracker = vid ? `<script>(function(){var vid=${JSON.stringify(vid)},t0=Date.now(),sent=false;
function ping(k){try{navigator.sendBeacon('/api/seen',JSON.stringify({vid:vid,k:k,ms:Date.now()-t0}))}catch(e){}}
setTimeout(function(){ping('js')},1500);
function act(){if(sent)return;sent=true;ping('act')}
['scroll','touchstart','mousemove','keydown'].forEach(function(e){addEventListener(e,act,{once:true,passive:true})});
})();</script>` : '';
  return html.replace('</body>', `${pixel}${tracker}</body>`);
}

// ---------- Telegram ----------
async function tg(method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${CFG.tgToken}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}
const DP_CACHE = new Map(); // clientId -> { fileId, buf, ctype, at } (channel DP image memory cache)
let BOT = { ok: false, username: '', message: DEMO ? 'DEMO मोड (TELEGRAM_BOT_TOKEN नहीं डाला)' : 'जाँच हो रही है…' };
async function checkBot() {
  if (DEMO) return;
  try { const me = await tg('getMe'); BOT = { ok: true, id: me.id, username: me.username, message: `@${me.username} जुड़ा है` }; }
  catch (e) { BOT = { ok: false, message: e.message }; }
}
// Har client ke channel ke total members (Telegram se)
async function refreshMemberCounts() {
  if (DEMO) return;
  for (const [id, c] of Object.entries(db.clients)) {
    const chat = c.chatId || c.tgChannel; if (!chat) continue;
    try { const n = await tg('getChatMemberCount', { chat_id: chat }); c.memberCount = n; c.memberCountAt = Date.now(); } catch (e) {}
    // Channel ki apni photo + title time-time pe refresh (auto-DP ke liye)
    try {
      const chat2 = await tg('getChat', { chat_id: chat });
      const pf = chat2.photo?.big_file_id || chat2.photo?.small_file_id || '';
      if (pf) c.photoFileId = pf;
      if (chat2.title) c.channelTitle = chat2.title;
    } catch (e) {}
  }
  save();
}
setInterval(refreshMemberCounts, 10 * 60e3).unref();
// Render free instance ko jagaye rakho — landing hamesha super-fast khule (cold-start na ho)
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || CFG.publicUrl || '').replace(/\/$/, '');
if (SELF_URL) setInterval(() => { fetch(SELF_URL + '/favicon.ico').catch(() => {}); }, 12 * 60e3).unref();
// bot ko client ke channel me admin verify karo + title le lo
async function verifyChannel(chan) {
  if (DEMO) return { ok: false, title: '', error: 'DEMO मोड: bot token नहीं डाला' };
  try {
    const chat = await tg('getChat', { chat_id: chan });
    const m = await tg('getChatMember', { chat_id: chat.id, user_id: BOT.id });
    if (m.status !== 'administrator') return { ok: false, title: chat.title, error: 'Bot channel में Admin नहीं है' };
    if (!m.can_invite_users) return { ok: false, title: chat.title, error: 'Bot को "Invite via link" permission नहीं है' };
    return { ok: true, title: chat.title, chatId: chat.id, photoFileId: chat.photo?.big_file_id || chat.photo?.small_file_id || '' };
  } catch (e) { return { ok: false, title: '', error: e.message }; }
}
async function inviteLinkFor(v, client) {
  if (v.invite && v.inviteExpires > Date.now() / 1000 + 60) return v.invite;
  const expire = Math.floor(Date.now() / 1000) + settings().linkTtlMin * 60;
  const link = await tg('createChatInviteLink', { chat_id: client.chatId || client.tgChannel, name: `v_${v.id}`, expire_date: expire, creates_join_request: true });
  v.invite = link.invite_link; v.inviteExpires = expire; save();
  return v.invite;
}
async function pollTelegram() {
  if (DEMO) return;
  try { await tg('deleteWebhook'); } catch {}
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset: db.tgOffset, timeout: 25, allowed_updates: ['chat_join_request', 'chat_member', 'my_chat_member'] });
      for (const u of updates) { db.tgOffset = u.update_id + 1; if (u.chat_join_request) await onJoinRequest(u.chat_join_request); if (u.chat_member) onMemberChange(u.chat_member); if (u.my_chat_member) onMyChatMember(u.my_chat_member); }
      if (updates.length) save();
    } catch (e) { console.error('telegram poll:', e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}
async function onJoinRequest(req) {
  const name = req.invite_link?.name || '';
  const vid = name.startsWith('v_') ? name.slice(2) : null;
  const v = vid && db.visitors[vid];
  const S = settings();
  const u = req.from;
  const usr = { id: u.id, username: u.username, name: [u.first_name, u.last_name].filter(Boolean).join(' ') };
  if (!v) {
    // "Not our invite" — kis client ke channel me aaya, chat.id se match
    const cid = Object.keys(db.clients).find((id) => String(db.clients[id].chatId) === String(req.chat.id));
    if (cid) (db.otherJoins ||= {})[cid] = (db.otherJoins[cid] || 0) + 1;
    if (S.autoApprove) { try { await tg('approveChatJoinRequest', { chat_id: req.chat.id, user_id: u.id }); } catch {} }
    save(); return;
  }
  v.requestAt = v.requestAt || Date.now();
  (db.pending ||= {})[String(u.id)] = { vid, chat: req.user_chat_id || u.id };
  // Bot auto-approve ON ho to turant approve (manual ho to admin baad me Telegram se karega)
  if (S.autoApprove) {
    try { await tg('approveChatJoinRequest', { chat_id: req.chat.id, user_id: u.id }); v.approvedBy = 'bot'; } catch (e) { console.error('approve:', e.message); }
    if (S.welcome) tg('sendMessage', { chat_id: req.user_chat_id || u.id, text: S.welcome }).catch(() => {});
  }
  // REQUEST aate hi Meta ko event bhejo — auto aur manual, dono me
  await markJoined(v, usr);
  save();
}
function onMemberChange(m) {
  const user = m.new_chat_member.user, status = m.new_chat_member.status;
  // user asli me channel ka member ban gaya (approve hone par) -> tabhi Meta event
  if (['member', 'administrator', 'creator'].includes(status)) {
    const p = db.pending && db.pending[String(user.id)];
    if (p) {
      const v = db.visitors[p.vid];
      if (v) {
        if (!v.approvedBy) v.approvedBy = 'you';   // manual approve (admin ne khud kiya)
        v.memberConfirmed = true; v.confirmedAt = v.confirmedAt || Date.now();
        if (!v.joinedAt) { if (settings().welcome) tg('sendMessage', { chat_id: p.chat || user.id, text: settings().welcome }).catch(() => {}); markJoined(v, { id: user.id, username: user.username, name: [user.first_name, user.last_name].filter(Boolean).join(' ') }); }
      }
      delete db.pending[String(user.id)]; save();
    }
  }
  const vid = db.tgUsers[user.id]; const v2 = vid && db.visitors[vid];
  if (v2 && ['left', 'kicked'].includes(status) && v2.joinedAt && !v2.leftAt) { v2.leftAt = Date.now(); save(); }
}
// Bot ko jab kisi channel me admin banaya/hataया jaata hai — us channel ko yaad rakho
function onMyChatMember(m) {
  const chat = m.chat, st = m.new_chat_member; if (!chat || !st) return;
  if (st.status === 'administrator') {
    db.channels[String(chat.id)] = { id: chat.id, title: chat.title || chat.username || String(chat.id), username: chat.username || '', type: chat.type, canInvite: !!st.can_invite_users, updated: Date.now() };
  } else { delete db.channels[String(chat.id)]; }
  save();
}
async function markJoined(v, user) {
  if (v.joinedAt) return;
  if (db.tgUsers[user.id] && db.tgUsers[user.id] !== v.id) { v.duplicateOf = db.tgUsers[user.id]; save(); return; }
  v.joinedAt = Date.now(); v.tgUser = user; db.tgUsers[user.id] = v.id;
  if (db.pending) delete db.pending[String(user.id)];
  save();
  const client = db.clients[v.clientId];
  if (client) await sendMetaEvent(v, client);
}

// ---------- Meta Conversions API (per client) ----------
async function sendMetaEvent(v, client, attempt = 1) {
  if (!client.pixel || !client.metaToken) { v.meta = 'skipped (pixel/token खाली)'; save(); return; }
  const user_data = { client_ip_address: v.ip, client_user_agent: v.ua, external_id: [sha256(v.tgUser?.id ?? v.id)] };
  if (v.fbc) user_data.fbc = v.fbc;
  if (v.fbp) user_data.fbp = v.fbp;
  const body = { data: [{
    event_name: client.metaEvent || 'Lead',
    event_time: Math.floor(v.joinedAt / 1000),
    event_id: `join_${v.id}`,
    action_source: 'website',
    event_source_url: v.url || CFG.publicUrl,
    user_data,
    custom_data: { content_name: client.channelTitle || client.name, content_category: 'telegram_join', source: v.source, landing_variant: v.variant },
  }] };
  if (client.metaTestCode) body.test_event_code = client.metaTestCode;
  try {
    const r = await fetch(`https://graph.facebook.com/${CFG.metaVersion}/${client.pixel}/events?access_token=${encodeURIComponent(client.metaToken)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || r.status);
    v.meta = 'sent';
  } catch (e) { v.meta = `error: ${e.message}`; if (attempt < 4) setTimeout(() => sendMetaEvent(v, client, attempt + 1), attempt * 60e3); }
  save();
}

// ---------- stats (dashboard shape) ----------
function emptyAgg() { const bySource = {}; for (const s of SOURCES) bySource[s] = { real: 0, fake: 0 }; return { total: 0, real: 0, fake: 0, bySource, byDay: {}, recent: [] }; }
function aggFor(clientId) {
  const a = emptyAgg();
  const list = Object.values(db.visitors).filter((v) => v.clientId === clientId);
  for (const v of list) {
    const src = normSource(v.source);
    const isReal = !!v.joinedAt;                 // verified channel join
    const isBot = !v.joinedAt && (v.bot || v.suspicious); // filtered bot/suspicious
    if (v.clickedAt || v.joinedAt) a.total++;    // total = join-button clicks
    if (isReal) { a.real++; a.bySource[src].real++; }
    if (isBot) { a.fake++; a.bySource[src].fake++; }
    const day = new Date(v.joinedAt || v.createdAt).toISOString().slice(0, 10);
    if (isReal || isBot) { (a.byDay[day] ||= { real: 0, fake: 0 }); if (isReal) a.byDay[day].real++; if (isBot) a.byDay[day].fake++; }
  }
  a.recent = list.filter((v) => v.joinedAt).sort((x, y) => y.joinedAt - x.joinedAt).slice(0, 50)
    .map((v) => ({ t: v.joinedAt, result: 'real', source: normSource(v.source), reason: (v.tgUser?.username ? '@' + v.tgUser.username : 'verified') + (v.meta === 'sent' ? ' • Meta ✓' : '') }));
  return a;
}
const DAY = 24 * 3600e3;
// Poora master analytics — platform, placements, telegram members, CAPI, traffic
function richStats(clientId) {
  const all = clientId == null;
  const list = all ? Object.values(db.visitors) : Object.values(db.visitors).filter((v) => v.clientId === clientId);
  const c = all ? {} : (db.clients[clientId] || {});
  const chMembers = all ? Object.values(db.clients).reduce((s, x) => s + (x.memberCount || 0), 0) : (c.memberCount ?? null);
  const notOur = all ? Object.values(db.otherJoins || {}).reduce((s, n) => s + n, 0) : ((db.otherJoins || {})[clientId] || 0);
  const platform = {}; for (const s of SOURCES) platform[s] = { visits: 0, clicks: 0, joins: 0, pct: 0 };
  const placeMap = {};
  let visits = 0, clicks = 0, joins = 0, fromAds = 0, left = 0, stayed = 0, requests = 0, approvedYou = 0, approvedBot = 0, capiSent = 0, capiErr = 0, withFbc = 0;
  const byDay = {}, ipCount = {};
  for (const v of list) {
    const s = normSource(v.source), paid = v.fbc ? 'paid' : 'organic';
    visits++; platform[s].visits++;
    if (v.ip) ipCount[v.ip] = (ipCount[v.ip] || 0) + 1;
    if (v.fbc) withFbc++;
    if (v.clickedAt) { clicks++; platform[s].clicks++; }
    if (v.requestAt) requests++;
    const pk = s + '|' + paid; (placeMap[pk] ||= { platform: s, placement: paid, visits: 0, clicks: 0, joins: 0 }); placeMap[pk].visits++;
    if (v.clickedAt) placeMap[pk].clicks++;
    if (v.joinedAt) {
      joins++; platform[s].joins++; placeMap[pk].joins++;
      if (v.fbc) fromAds++;
      if (v.approvedBy === 'you') approvedYou++; else if (v.approvedBy === 'bot') approvedBot++;
      if (v.meta === 'sent') capiSent++; else if (v.meta && String(v.meta).startsWith('error')) capiErr++;
      if (v.leftAt) left++;
      const stayMs = (v.leftAt || Date.now()) - (v.confirmedAt || v.joinedAt);
      if (stayMs > DAY) stayed++;
      const d = new Date(v.joinedAt).toISOString().slice(0, 10); (byDay[d] ||= { real: 0, fake: 0 }).real++;
    } else if (v.bot || v.suspicious) {
      const d = new Date(v.createdAt).toISOString().slice(0, 10); (byDay[d] ||= { real: 0, fake: 0 }).fake++;
    }
  }
  const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
  for (const s of SOURCES) platform[s].pct = pct(platform[s].joins, joins);
  const pending = Object.values(db.pending || {}).filter((p) => { const v = db.visitors[p.vid]; return v && (all || v.clientId === clientId); }).length;
  const ips4 = Object.values(ipCount).filter((n) => n >= 4).length;
  const fake = list.filter((v) => !v.joinedAt && (v.bot || v.suspicious)).length;
  const inCh = Math.max(0, joins - left);
  const funnel = { visits, clicks, joins, inChannel: inCh, clickRate: pct(clicks, visits), joinRate: pct(joins, clicks), stayRate: pct(inCh, joins) };
  const vmap = {};
  for (const v of list) { const n = v.variant || '?'; (vmap[n] ||= { visits: 0, joins: 0 }); vmap[n].visits++; if (v.joinedAt) vmap[n].joins++; }
  const designPerf = Object.entries(vmap).map(([name, x]) => ({ name, visits: x.visits, joins: x.joins, rate: pct(x.joins, x.visits) })).sort((a, b) => b.joins - a.joins);
  // Unique insights: bot block reasons + avg time-to-join
  const blockReasons = {}; let ttjSum = 0, ttjN = 0;
  for (const v of list) {
    if (!v.joinedAt && (v.bot || v.suspicious)) { const rn = v.botReason || (v.suspicious ? 'suspicious-ip' : 'bot'); blockReasons[rn] = (blockReasons[rn] || 0) + 1; }
    if (v.joinedAt && v.createdAt) { ttjSum += (v.joinedAt - v.createdAt); ttjN++; }
  }
  const avgJoinSec = ttjN ? Math.round(ttjSum / ttjN / 1000) : 0;
  return {
    total: clicks, real: joins, fake, funnel, designPerf, blockReasons, avgJoinSec,
    channel: { title: all ? 'All channels' : (c.channelTitle || c.name), members: chMembers, membersAt: c.memberCountAt || null },
    platform,
    placements: Object.values(placeMap).sort((a, b) => b.joins - a.joins),
    members: { joins, fromAds, left, stay24h: pct(stayed, joins), pending, requests, approvedYou, approvedBot, capiAtRequest: capiSent },
    capi: { sent: capiSent, errors: capiErr, notOurInvite: notOur },
    traffic: { visitClickGap: pct(visits - clicks, visits), withFbclid: pct(withFbc, visits), ips4plus: ips4 },
    bySource: { instagram: { real: platform.instagram.joins, fake: 0 }, facebook: { real: platform.facebook.joins, fake: 0 }, other: { real: platform.other.joins, fake: 0 } },
    byDay, visits,
  };
}
// Har subscriber ki A-Z detail
function subscriberList(clientId) {
  return Object.values(db.visitors).filter((v) => (clientId == null || v.clientId === clientId) && v.joinedAt)
    .sort((a, b) => b.joinedAt - a.joinedAt).slice(0, 300)
    .map((v) => {
      const inChannel = !v.leftAt;
      const stayMs = (v.leftAt || Date.now()) - (v.confirmedAt || v.joinedAt);
      return {
        username: v.tgUser?.username ? '@' + v.tgUser.username : 'Unknown',
        name: v.tgUser?.name || '',
        joinedAt: v.joinedAt, leftAt: v.leftAt || null, inChannel,
        stayMin: Math.max(0, Math.round(stayMs / 60000)),
        source: normSource(v.source), fromAd: !!v.fbc,
        approvedBy: v.approvedBy || '-', meta: v.meta || '-',
      };
    });
}
function publicClients() { const out = {}; for (const [id, c] of Object.entries(db.clients)) out[id] = { name: c.name, pixel: c.pixel, join: `/?c=${id}` }; return out; }

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // ----- landing (short link /<clientId> ya /?c=<clientId>) -----
    const seg = p.slice(1);
    const RESERVED = new Set(['go', 'dp', 'join', 'seen', 'favicon.ico', 'robots.txt', 'dashboard.html', 'api']);
    const pathCid = (req.method === 'GET' && !RESERVED.has(seg) && /^[a-z0-9_-]{1,24}$/i.test(seg) && db.clients[seg]) ? seg : null;
    if (req.method === 'GET' && (p === '/' || p === '/go' || pathCid)) {
      const cid = pathCid || url.searchParams.get('c');
      const client = cid && db.clients[cid];
      if (!client) {
        const ids = Object.keys(db.clients);
        return send(res, 200, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:460px;margin:50px auto;padding:0 18px;color:#222">
          <h2>JoinHub</h2><p>Is link me client id (<code>?c=...</code>) nahi hai ya galat hai.</p>
          ${ids.length ? '<p>Dashboard se client ka landing link lo.</p>' : '<p>Pehle <a href="/dashboard.html">dashboard</a> me client add karo.</p>'}</body>`);
      }
      const ua = req.headers['user-agent'] || '';
      const c = cookies(req);
      let v = c.jh_vid && db.visitors[c.jh_vid];
      if (v && v.clientId !== cid) v = null; // naya client = naya visitor
      if (BOT_UA.test(ua) || !ua) { const variant = (v && v.variant) || variants()[0]; if (!variant) return send(res, 500, 'landings/ me koi page nahi'); return send(res, 200, renderLanding(variant, null, client, cid)); }
      if (!v) {
        const variant = pickVariant(cid); if (!variant) return send(res, 500, 'landings/ me koi page nahi');
        const ip = clientIp(req); const hourAgo = Date.now() - 3600e3;
        const sameIp = Object.values(db.visitors).filter((x) => x.ip === ip && x.createdAt > hourAgo).length;
        const fbclid = url.searchParams.get('fbclid');
        v = { id: newId(), clientId: cid, variant, createdAt: Date.now(), ip, ua, url: baseUrl(req) + req.url,
          source: detectSource(url, req),
          fbc: c._fbc || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined), fbp: c._fbp,
          suspicious: sameIp >= 5 || undefined };
        db.visitors[v.id] = v; (db.variantShown[cid] ||= {})[variant] = ((db.variantShown[cid] || {})[variant] || 0) + 1; save();
      }
      if (!variants().includes(v.variant)) v.variant = pickVariant(cid);
      // Invite link pehle hi background me bana lo — taaki Join dabate hi turant (super-fast) khule
      if (!DEMO && (client.chatId || client.tgChannel)) inviteLinkFor(v, client).catch(() => {});
      return send(res, 200, renderLanding(v.variant, v.id, client, cid), { 'Set-Cookie': `jh_vid=${v.id}; Path=/; Max-Age=2592000; SameSite=Lax` });
    }

    // ----- channel DP proxy (token server-side hi rehta hai) -----
    if (req.method === 'GET' && p === '/dp') {
      const cid = url.searchParams.get('c');
      const client = cid && db.clients[cid];
      if (DEMO || !client || !client.photoFileId) { res.writeHead(404); return res.end('no dp'); }
      try {
        const cached = DP_CACHE.get(cid);
        if (cached && cached.fileId === client.photoFileId && Date.now() - cached.at < 6 * 3600e3) {
          res.writeHead(200, { 'Content-Type': cached.ctype, 'Cache-Control': 'public, max-age=21600' });
          return res.end(cached.buf);
        }
        const f = await tg('getFile', { file_id: client.photoFileId });
        const fr = await fetch(`https://api.telegram.org/file/bot${CFG.tgToken}/${f.file_path}`);
        if (!fr.ok) { res.writeHead(404); return res.end('no dp'); }
        const ctype = fr.headers.get('content-type') || 'image/jpeg';
        const buf = Buffer.from(await fr.arrayBuffer());
        DP_CACHE.set(cid, { fileId: client.photoFileId, buf, ctype, at: Date.now() });
        res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=21600' });
        return res.end(buf);
      } catch { res.writeHead(404); return res.end('no dp'); }
    }

    // ----- human beacon -----
    if (req.method === 'POST' && p === '/api/seen') {
      try { const { vid, k } = JSON.parse(await readBody(req)); const v = db.visitors[vid]; if (v) { if (k === 'js') v.human = true; if (k === 'act') { v.human = true; v.interacted = true; } save(); } } catch {}
      return send(res, 204, '');
    }

    // ----- join button -----
    if (req.method === 'GET' && p === '/join') {
      const v = db.visitors[url.searchParams.get('vid')]; if (!v) return send(res, 302, '', { Location: '/' });
      const client = db.clients[v.clientId]; if (!client) return send(res, 302, '', { Location: '/' });
      if (!v.clickedAt) { v.clickedAt = Date.now(); if (!v.human) { v.bot = true; v.botReason = v.botReason || 'no-js'; } }
      if (BOT_UA.test(v.ua) || !v.ua) { v.bot = true; v.botReason = 'bot-ua'; }
      const c = cookies(req); if (c._fbp) v.fbp = c._fbp; if (c._fbc && !v.fbc) v.fbc = c._fbc;
      save();
      if (DEMO) return send(res, 302, '', { Location: `/demo-join?vid=${v.id}` });
      try { return send(res, 302, '', { Location: await inviteLinkFor(v, client) }); }
      catch (e) { console.error('invite:', e.message); return send(res, 500, `<p style="font:16px sans-serif;padding:24px">Abhi link nahi bana, thodi der baad try karein.</p>`); }
    }

    // ----- DEMO: fake telegram to test without a bot -----
    if (DEMO && p === '/demo-join') {
      const v = db.visitors[url.searchParams.get('vid')]; if (!v) return send(res, 302, '', { Location: '/' });
      if (req.method === 'POST') { await markJoined(v, { id: 900000000 + Math.floor(Math.random() * 1e8), username: 'demo_user', name: 'Demo User' }); return send(res, 302, '', { Location: `/demo-join?vid=${v.id}&done=1` }); }
      const done = url.searchParams.get('done');
      return send(res, 200, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:430px;margin:44px auto;padding:0 16px">
        <h2>🧪 DEMO Telegram</h2><p>Asli Telegram ki jagah ye nakli page hai (bot token nahi daala).</p>
        ${done ? '<p style="color:#17994f"><b>✔ Join ho gaya.</b> Ab dashboard dekho: <a href="/dashboard.html">/dashboard.html</a></p>' : `<form method=post><button style="font-size:18px;padding:12px 22px;border:0;border-radius:10px;background:#229ED9;color:#fff">Channel Join karein (simulate)</button></form>`}</body>`);
    }

    // ----- admin API -----
    if (p === '/api/clients') {
      if (req.method === 'GET' && !url.searchParams.get('admin')) return json(res, 200, publicClients());
      if (!okKey(url)) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET') return json(res, 200, { clients: db.clients, bot: BOT });
      if (req.method === 'POST' || req.method === 'PUT') {
        let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
        const name = String(b.name || '').trim(); if (!name) return json(res, 400, { error: 'name required' });
        const id = (b.id && String(b.id).trim()) || slug(name);
        const prev = db.clients[id] || {};
        const client = { name, pixel: String(b.pixel || '').trim(), metaToken: String(b.metaToken || '').trim(),
          metaTestCode: String(b.metaTestCode || '').trim(), metaEvent: String(b.metaEvent || 'Lead').trim() || 'Lead',
          tgChannel: String(b.tgChannel || '').trim(), chatId: prev.chatId, channelTitle: prev.channelTitle, photoFileId: prev.photoFileId,
          dpUrl: String(b.dpUrl || '').trim(), landingTitle: String(b.landingTitle || '').trim(),
          created: prev.created || Date.now(), updated: Date.now() };
        // bot ko channel me verify karo (agar token + channel diya hai)
        let verify = null;
        if (client.tgChannel && !DEMO) { verify = await verifyChannel(client.tgChannel); if (verify.ok) { client.chatId = verify.chatId; client.channelTitle = verify.title; if (verify.photoFileId) client.photoFileId = verify.photoFileId; } }
        db.clients[id] = client; save();
        return json(res, 200, { ok: true, id, client, verify });
      }
      if (req.method === 'DELETE') { const id = url.searchParams.get('id'); if (id && db.clients[id]) { delete db.clients[id]; delete db.variantShown[id]; save(); } return json(res, 200, { ok: true }); }
      return json(res, 405, { error: 'method not allowed' });
    }
    if (p === '/api/stats') {
      if (!okKey(url)) return json(res, 401, { error: 'unauthorized' });
      const cid = url.searchParams.get('clientId');
      if (cid) { if (!db.clients[cid]) return json(res, 400, { error: 'unknown client' }); return json(res, 200, { clientId: cid, client: db.clients[cid], agg: aggFor(cid), rich: richStats(cid) }); }
      const out = {}; for (const id of Object.keys(db.clients)) { const a = aggFor(id); out[id] = { name: db.clients[id].name, total: a.total, real: a.real, fake: a.fake }; }
      return json(res, 200, { clients: out, bot: BOT, demo: DEMO, rich: richStats(null) });
    }
    if (p === '/api/subscribers') {
      if (!okKey(url)) return json(res, 401, { error: 'unauthorized' });
      const cid = url.searchParams.get('clientId');
      if (cid && !db.clients[cid]) return json(res, 400, { error: 'unknown client' });
      return json(res, 200, { subscribers: subscriberList(cid || null) });
    }
    if (p === '/api/channels') {
      if (!okKey(url)) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { channels: Object.values(db.channels || {}) });
    }
    if (p === '/api/settings') {
      if (!okKey(url)) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET') return json(res, 200, { settings: settings(), bot: BOT, demo: DEMO, designs: variants().length });
      if (req.method === 'POST' || req.method === 'PUT') {
        let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
        if (b.welcome !== undefined) db.settings.welcome = String(b.welcome).slice(0, 500);
        if (b.autoApprove !== undefined) db.settings.autoApprove = !!b.autoApprove;
        if (b.linkTtlMin !== undefined) db.settings.linkTtlMin = Math.max(5, Math.min(10080, Number(b.linkTtlMin) || 120));
        save();
        return json(res, 200, { ok: true, settings: settings() });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    // ----- static (sirf dashboard.html — baaki files kabhi serve nahi) -----
    if (req.method === 'GET') {
      if (p === '/admin') return send(res, 302, '', { Location: '/dashboard.html' });
      if (p === '/dashboard.html') { const f = path.join(ROOT, 'dashboard.html'); if (fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), { 'Content-Type': 'text/html; charset=utf-8' }); }
    }
    if (p === '/favicon.ico') return send(res, 204, '');
    send(res, 404, 'Not found');
  } catch (e) { console.error(e); send(res, 500, 'Server error'); }
});

async function boot() {
  if (useUpstash) await loadDbRemote();
  server.listen(CFG.port, onListen);
}
async function onListen() {
  console.log(`\n  JoinHub chal raha hai:`);
  console.log(`  Dashboard : ${CFG.publicUrl || 'http://localhost:' + CFG.port}/dashboard.html   (key: ${CFG.adminKey})`);
  console.log(`  Landing   : /<clientId>  (short)  ya  /?c=<clientId>`);
  console.log(`  Designs   : ${variants().join(', ') || '(koi nahi)'}`);
  console.log(`  Storage   : ${useUpstash ? 'Upstash (permanent) ✓' : 'local file (Render par reset ho sakta hai)'}`);
  if (DEMO) console.log('  ⚠ DEMO mode: .env me TELEGRAM_BOT_TOKEN daalo for real joins.');
  await checkBot();
  console.log(`  Telegram  : ${BOT.message}\n`);
  refreshMemberCounts();
  pollTelegram();
}
boot();
