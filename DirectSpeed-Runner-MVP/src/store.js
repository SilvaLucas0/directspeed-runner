import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = process.env.DATA_DIR || './data';
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'directspeed.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'online',
  session_state TEXT NOT NULL DEFAULT 'disconnected',
  instagram_username TEXT,
  current_state TEXT NOT NULL DEFAULT 'parado',
  current_lead TEXT,
  active_message TEXT,
  next_action_at TEXT,
  pause_until TEXT,
  sent_today INTEGER NOT NULL DEFAULT 0,
  cycle_processed INTEGER NOT NULL DEFAULT 0,
  cycle_target INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Fila Cloud',
  settings_json TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  template_used TEXT,
  error_message TEXT,
  processed_at TEXT,
  sent_at TEXT,
  UNIQUE(user_id, username)
);
CREATE INDEX IF NOT EXISTS idx_leads_user_status ON leads(user_id, status, id);
CREATE TABLE IF NOT EXISTS sent_history (
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY(user_id, username)
);
CREATE TABLE IF NOT EXISTS hour_sends (
  user_id TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hour_sends_user ON hour_sends(user_id, sent_at_ms);
CREATE TABLE IF NOT EXISTS daily_count (
  user_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, date_key)
);
`);

const defaults = {
  leadsPerCycle: 15, pauseMinutes: 60, dailyLimit: 40, maxPerHour: 20,
  minDelay: 60, maxDelay: 180, hourStart: 7, hourEnd: 23,
  order: 'sequential', safeMode: true, stopAfterErrors: 4, dailyCeiling: 100
};

export function ensureUser(user) {
  db.prepare('INSERT OR IGNORE INTO users(user_id,email,created_at) VALUES(?,?,?)').run(user.id, user.email || '', new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO state(user_id,updated_at) VALUES(?,?)').run(user.id, new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO campaign(user_id,settings_json,messages_json,updated_at) VALUES(?,?,?,?)')
    .run(user.id, JSON.stringify(defaults), JSON.stringify([]), new Date().toISOString());
}

export function getState(userId) {
  const row = db.prepare('SELECT * FROM state WHERE user_id=?').get(userId) || {};
  const counts = db.prepare(`SELECT
    COUNT(*) total,
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) processing,
    SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) sent,
    SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors
    FROM leads WHERE user_id=?`).get(userId);
  const campaign = getCampaign(userId);
  return {
    ...row,
    queueTotal: Number(counts?.total || 0), queuePending: Number(counts?.pending || 0),
    queueProcessing: Number(counts?.processing || 0), queueSent: Number(counts?.sent || 0),
    queueErrors: Number(counts?.errors || 0), campaign
  };
}

export function patchState(userId, patch) {
  const allowed = ['status','session_state','instagram_username','current_state','current_lead','active_message','next_action_at','pause_until','sent_today','cycle_processed','cycle_target','last_error'];
  const entries = Object.entries(patch).filter(([k]) => allowed.includes(k));
  if (!entries.length) return getState(userId);
  entries.push(['updated_at', new Date().toISOString()]);
  const sql = `UPDATE state SET ${entries.map(([k])=>`${k}=?`).join(',')} WHERE user_id=?`;
  db.prepare(sql).run(...entries.map(([,v])=>v ?? null), userId);
  return getState(userId);
}

export function getCampaign(userId) {
  const r = db.prepare('SELECT * FROM campaign WHERE user_id=?').get(userId);
  if (!r) return { name:'Fila Cloud', settings:{...defaults}, messages:[] };
  return { name:r.name, settings:{...defaults,...JSON.parse(r.settings_json||'{}')}, messages:JSON.parse(r.messages_json||'[]'), updatedAt:r.updated_at };
}

export function saveCampaign(userId, payload) {
  const current = getCampaign(userId);
  const name = String(payload.name ?? current.name ?? 'Fila Cloud').slice(0,120);
  const settings = {...current.settings,...(payload.settings||{})};
  const messages = Array.isArray(payload.messages) ? payload.messages.slice(0,5) : current.messages;
  db.prepare('UPDATE campaign SET name=?, settings_json=?, messages_json=?, updated_at=? WHERE user_id=?')
    .run(name, JSON.stringify(settings), JSON.stringify(messages), new Date().toISOString(), userId);
  return getCampaign(userId);
}

export function addLeads(userId, usernames) {
  const ins = db.prepare("INSERT OR IGNORE INTO leads(user_id,username,status) VALUES(?,?,'pending')");
  const tx = db.transaction(items => { let added=0; for (const u of items) { const r=ins.run(userId,u); added += Number(r.changes||0); } return added; });
  return tx(usernames);
}

export function listLeads(userId, {status,limit=100,offset=0}={}) {
  limit = Math.min(500, Math.max(1, Number(limit)||100)); offset=Math.max(0,Number(offset)||0);
  if (status) return db.prepare('SELECT * FROM leads WHERE user_id=? AND status=? ORDER BY id LIMIT ? OFFSET ?').all(userId,status,limit,offset);
  return db.prepare('SELECT * FROM leads WHERE user_id=? ORDER BY id LIMIT ? OFFSET ?').all(userId,limit,offset);
}
export function clearPending(userId){ return db.prepare("DELETE FROM leads WHERE user_id=? AND status IN ('pending','error','skipped')").run(userId).changes; }
export function resetQueue(userId){ db.prepare("UPDATE leads SET status='pending',template_used=NULL,error_message=NULL,processed_at=NULL,sent_at=NULL WHERE user_id=? AND username NOT IN (SELECT username FROM sent_history WHERE user_id=?)").run(userId,userId); }
export function recoverProcessing(userId){ db.prepare("UPDATE leads SET status='pending' WHERE user_id=? AND status='processing'").run(userId); }

export function nextLead(userId, order='sequential') {
  const row = order==='random'
    ? db.prepare("SELECT * FROM leads WHERE user_id=? AND status='pending' ORDER BY RANDOM() LIMIT 1").get(userId)
    : db.prepare("SELECT * FROM leads WHERE user_id=? AND status='pending' ORDER BY id LIMIT 1").get(userId);
  if (row) db.prepare("UPDATE leads SET status='processing',processed_at=? WHERE id=?").run(new Date().toISOString(),row.id);
  return row;
}
export function markLead(userId,id,status,extra={}){
  db.prepare('UPDATE leads SET status=?,template_used=?,error_message=?,processed_at=?,sent_at=? WHERE user_id=? AND id=?')
    .run(status,extra.templateUsed||null,extra.errorMessage||null,new Date().toISOString(),status==='sent'?new Date().toISOString():null,userId,id);
}
export function wasSent(userId,username){ return !!db.prepare('SELECT 1 FROM sent_history WHERE user_id=? AND username=?').get(userId,username); }
export function recordSent(userId,username){ const now=new Date().toISOString(); db.prepare('INSERT OR REPLACE INTO sent_history(user_id,username,sent_at) VALUES(?,?,?)').run(userId,username,now); const ms=Date.now(); db.prepare('INSERT INTO hour_sends(user_id,sent_at_ms) VALUES(?,?)').run(userId,ms); const key=new Date().toISOString().slice(0,10); db.prepare('INSERT INTO daily_count(user_id,date_key,count) VALUES(?,?,1) ON CONFLICT(user_id,date_key) DO UPDATE SET count=count+1').run(userId,key); }
export function dailyCount(userId){ const key=new Date().toISOString().slice(0,10); return Number(db.prepare('SELECT count FROM daily_count WHERE user_id=? AND date_key=?').get(userId,key)?.count||0); }
export function hourCount(userId){ const cutoff=Date.now()-3600000; db.prepare('DELETE FROM hour_sends WHERE user_id=? AND sent_at_ms<?').run(userId,cutoff); return Number(db.prepare('SELECT COUNT(*) c FROM hour_sends WHERE user_id=?').get(userId)?.c||0); }

// Estados em que o loop estava vivo antes do processo morrer — usados para retomar no boot.
const RESUMABLE = ['rodando','aguardando','pausado','pausa_ciclo','limite_hora'];
export function listResumableUsers(){
  const marks = RESUMABLE.map(()=>'?').join(',');
  return db.prepare(`SELECT user_id, current_state FROM state WHERE current_state IN (${marks})`).all(...RESUMABLE);
}
