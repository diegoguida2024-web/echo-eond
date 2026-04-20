// ╔══════════════════════════════════════════════════════════════╗
// ║     E.C.H.O. — Smart Dispatcher v3.1                        ║
// ║     Discord + Telegram | SQLite | Projects | Tickets         ║
// ║     Railway-ready · Crash-proof · Telegram-fixed             ║
// ╚══════════════════════════════════════════════════════════════╝

'use strict';
require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ThreadAutoArchiveDuration,
  MessageFlags
} = require('discord.js');
const Database    = require('better-sqlite3');
const cron        = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const http        = require('http');
const crypto      = require('crypto');
const path        = require('path');
const fs          = require('fs');

// ══════════════════════════════════════════════════════════════
//  ENV — validazione all'avvio
// ══════════════════════════════════════════════════════════════
const TOKEN           = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.DISCORD_CLIENT_ID;
const GUILD_ID        = process.env.DISCORD_GUILD_ID;
const CH_TASK_BOARD   = process.env.CHANNEL_TASK_BOARD;
const CH_BUG_TRACKER  = process.env.CHANNEL_BUG_TRACKER;
const CH_DEV_REQUESTS = process.env.CHANNEL_DEV_REQUESTS;
const CH_LOG          = process.env.CHANNEL_LOG;
const CH_TICKETS      = process.env.CHANNEL_TICKETS   || null;
const ROLE_EXECUTIVE  = process.env.ROLE_EXECUTIVE    || null;
const ROLE_OPS        = process.env.ROLE_OPS          || null;
const TG_TOKEN        = process.env.TELEGRAM_TOKEN    || null;
const TG_LOG_CHAT     = process.env.TELEGRAM_LOG_CHAT || null;
const GH_SECRET       = process.env.GITHUB_WEBHOOK_SECRET || null;
const WEBHOOK_PORT    = parseInt(process.env.WEBHOOK_PORT) || 3001;
const DB_PATH         = process.env.DB_PATH || path.join(__dirname, 'dispatcher.db');

if (!TOKEN)     { console.error('[E.C.H.O.] ERRORE: DISCORD_TOKEN mancante!');    process.exit(1); }
if (!CLIENT_ID) { console.error('[E.C.H.O.] ERRORE: DISCORD_CLIENT_ID mancante!'); process.exit(1); }
if (!GUILD_ID)  { console.error('[E.C.H.O.] ERRORE: DISCORD_GUILD_ID mancante!');  process.exit(1); }

// ══════════════════════════════════════════════════════════════
//  DATABASE — con statement cache per performance
// ══════════════════════════════════════════════════════════════
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = 10000');
db.pragma('temp_store = MEMORY');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    UNIQUE NOT NULL,
    name        TEXT    NOT NULL,
    description TEXT    DEFAULT '',
    status      TEXT    DEFAULT 'active',
    client_name TEXT    DEFAULT NULL,
    created_by  TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    UNIQUE NOT NULL,
    project_id  INTEGER DEFAULT NULL,
    title       TEXT    NOT NULL,
    description TEXT    DEFAULT '',
    priority    TEXT    DEFAULT 'medium',
    category    TEXT    DEFAULT 'task',
    status      TEXT    DEFAULT 'open',
    assigned_to TEXT    DEFAULT NULL,
    created_by  TEXT    NOT NULL,
    channel_id  TEXT    NOT NULL,
    thread_id   TEXT    DEFAULT NULL,
    message_id  TEXT    DEFAULT NULL,
    due_date    INTEGER DEFAULT NULL,
    tags        TEXT    DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS task_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_code  TEXT    NOT NULL,
    author_id  TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_code  TEXT    NOT NULL,
    remind_at  INTEGER NOT NULL,
    sent       INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT    UNIQUE NOT NULL,
    tg_user_id   TEXT    NOT NULL,
    tg_username  TEXT    DEFAULT NULL,
    tg_name      TEXT    DEFAULT NULL,
    service_type TEXT    NOT NULL,
    description  TEXT    NOT NULL,
    status       TEXT    DEFAULT 'open',
    task_code    TEXT    DEFAULT NULL,
    discord_msg  TEXT    DEFAULT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS counters (
    name  TEXT PRIMARY KEY,
    val   INTEGER DEFAULT 0
  );

  INSERT OR IGNORE INTO counters VALUES ('task',    0);
  INSERT OR IGNORE INTO counters VALUES ('project', 0);
  INSERT OR IGNORE INTO counters VALUES ('ticket',  0);
`);

// ── Prepared statements cache (performance) ──────────────────
const stmt = {
  nextCounter  : db.prepare('UPDATE counters SET val=val+1 WHERE name=? RETURNING val'),
  insertTask   : db.prepare(`INSERT INTO tasks (code,project_id,title,description,priority,category,status,created_by,channel_id,due_date,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  getTask      : db.prepare('SELECT * FROM tasks WHERE code=?'),
  updateTask   : db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE code=?'),
  updateAssign : db.prepare('UPDATE tasks SET assigned_to=?,status=?,updated_at=? WHERE code=?'),
  updateMsgId  : db.prepare('UPDATE tasks SET thread_id=?,message_id=?,updated_at=? WHERE code=?'),
  updatePrio   : db.prepare('UPDATE tasks SET priority=?,updated_at=? WHERE code=?'),
  updateDue    : db.prepare('UPDATE tasks SET due_date=?,updated_at=? WHERE code=?'),
  insertNote   : db.prepare('INSERT INTO task_notes (task_code,author_id,content,created_at) VALUES (?,?,?,?)'),
  getNotes     : db.prepare('SELECT * FROM task_notes WHERE task_code=? ORDER BY created_at DESC LIMIT 3'),
  insertRemind : db.prepare('INSERT INTO reminders (task_code,remind_at) VALUES (?,?)'),
  delReminders : db.prepare('DELETE FROM reminders WHERE task_code=?'),
  dueReminders : db.prepare('SELECT * FROM reminders WHERE remind_at<=? AND sent=0'),
  sentReminder : db.prepare('UPDATE reminders SET sent=1 WHERE id=?'),
  insertProject: db.prepare('INSERT INTO projects (code,name,description,client_name,created_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'),
  getProject   : db.prepare('SELECT * FROM projects WHERE UPPER(code)=?'),
  closeProject : db.prepare('UPDATE projects SET status=?,updated_at=? WHERE UPPER(code)=?'),
  insertTicket : db.prepare(`INSERT INTO tickets (code,tg_user_id,tg_username,tg_name,service_type,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`),
  getTicket    : db.prepare('SELECT * FROM tickets WHERE code=?'),
  updateTicket : db.prepare('UPDATE tickets SET status=?,updated_at=? WHERE code=?'),
  setTicketMsg : db.prepare('UPDATE tickets SET discord_msg=?,task_code=?,updated_at=? WHERE code=?'),
  taskMsgId    : db.prepare('SELECT * FROM tasks WHERE message_id=?'),
};

function nextCode(type) {
  const prefix = { task: 'T', project: 'P', ticket: 'TKT' }[type];
  const pad    = type === 'ticket' ? 3 : 3;
  const row    = stmt.nextCounter.get(type);
  return `${prefix}-${String(row.val).padStart(pad, '0')}`;
}

// ══════════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════════
const now  = () => Math.floor(Date.now() / 1000);
const ts   = u  => `<t:${u}:R>`;
const tsF  = u  => `<t:${u}:F>`;
const tsD  = u  => `<t:${u}:D>`;
const EPH  = { flags: MessageFlags.Ephemeral };

function fmtActor(id) {
  if (!id || id === 'github')   return '`GitHub`';
  if (id === 'telegram')        return '`Telegram`';
  if (/^\d{15,20}$/.test(id))   return `<@${id}>`;
  return `\`${id}\``;
}

function bar(done, total, len = 10) {
  if (!total) return `${'░'.repeat(len)} 0%`;
  const f = Math.round((done / total) * len);
  return `${'█'.repeat(f)}${'░'.repeat(len - f)} ${Math.round((done / total) * 100)}%`;
}

// ── Escape MarkdownV2 Telegram ────────────────────────────────
const esc = s => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

// ══════════════════════════════════════════════════════════════
//  COSTANTI UI
// ══════════════════════════════════════════════════════════════
const COLOR = {
  gold: 0xD4AF37, blue: 0x2F80ED, cyan: 0x00A3FF, green: 0x27AE60,
  orange: 0xFF6B35, red: 0xFF0000, amber: 0xF39C12, purple: 0x8E44AD,
  grey: 0x2C2F33,
  critical: 0xFF0000, high: 0xFF6B35, medium: 0xF39C12, low: 0x27AE60,
};

const P_EMOJI = { critical:'🚨', high:'🔥', medium:'❗', low:'⏳' };
const S_EMOJI = { open:'🔵', in_progress:'🟡', blocked:'🔴', completed:'✅', cancelled:'🚫', reviewing:'🔍' };
const S_LABEL = { open:'Open', in_progress:'In Progress', blocked:'Bloccato', completed:'Completato', cancelled:'Annullato', reviewing:'In Review' };
const C_EMOJI = { bug:'🐛', feature:'✨', task:'📋', request:'📨', urgent:'⚡', docs:'📝' };

const SERVICES = [
  { id:'discord_setup',    label:'Setup Server Discord',        emoji:'🖥️',  price:'30–80€'        },
  { id:'bot_commission',   label:'Bot Discord su commissione',  emoji:'🤖',  price:'50–150€'       },
  { id:'dispatcher',       label:'Installazione Dispatcher',    emoji:'⚙️',  price:'40–100€'       },
  { id:'discord_template', label:'Template Discord',            emoji:'📦',  price:'5–15€'         },
  { id:'consulting',       label:'Consulenza tecnica',          emoji:'💬',  price:'20–50€/h'      },
  { id:'other',            label:'Personalizzato',              emoji:'✏️',  price:'Da concordare'  },
];

// ══════════════════════════════════════════════════════════════
//  ANALYSIS ENGINE
// ══════════════════════════════════════════════════════════════
function analyzePriority(text) {
  const t = text.toLowerCase();
  if (['critico','critical','hotfix','emergenza','production down','impossibile'].some(k => t.includes(k))) return 'critical';
  if (['urgente','urgent','bug','crash','broken','non funziona','asap','entro oggi','errore','error','fix'].some(k => t.includes(k))) return 'high';
  if (['migliora','miglioramento','improve','idea','quando puoi','opzionale','optional'].some(k => t.includes(k))) return 'low';
  return 'medium';
}

function analyzeCategory(text) {
  const t = text.toLowerCase();
  if (['bug','fix','crash','errore'].some(k => t.includes(k)))              return 'bug';
  if (['feature','aggiungi','implement','nuovo'].some(k => t.includes(k))) return 'feature';
  if (['richiesta','request','cliente'].some(k => t.includes(k)))          return 'request';
  if (['urgente','critico','asap'].some(k => t.includes(k)))               return 'urgent';
  if (['doc','readme','guida'].some(k => t.includes(k)))                   return 'docs';
  return 'task';
}

function parseDeadline(text) {
  if (!text) return null;
  const t = text.toLowerCase(), d = new Date();
  if (t.includes('oggi')    || t.includes('today'))    { d.setHours(23,59,0,0); return Math.floor(d/1000); }
  if (t.includes('domani')  || t.includes('tomorrow')) { d.setDate(d.getDate()+1); d.setHours(23,59,0,0); return Math.floor(d/1000); }
  if (t.includes('dopodomani'))                         { d.setDate(d.getDate()+2); d.setHours(23,59,0,0); return Math.floor(d/1000); }
  const m = t.match(/(?:entro|in|tra)\s+(\d+)\s*(ore?|giorni?|settiman[ae])/);
  if (m) {
    const n = parseInt(m[1]);
    if (m[2].startsWith('or'))   d.setHours(d.getHours() + n);
    if (m[2].startsWith('gior')) d.setDate(d.getDate() + n);
    if (m[2].startsWith('sett')) d.setDate(d.getDate() + n * 7);
    return Math.floor(d / 1000);
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
//  EMBED BUILDERS
// ══════════════════════════════════════════════════════════════
function buildTaskEmbed(task, notes = []) {
  const project  = task.project_id ? db.prepare('SELECT code,name,client_name FROM projects WHERE id=?').get(task.project_id) : null;
  const isOverdue = task.due_date && task.due_date < now() && !['completed','cancelled'].includes(task.status);
  const color    = isOverdue ? COLOR.red : (COLOR[task.priority] || COLOR.blue);
  const pE = P_EMOJI[task.priority] || '❓';
  const sE = S_EMOJI[task.status]   || '❓';
  const cE = C_EMOJI[task.category] || '📋';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${cE}  \`${task.code}\` — ${task.title}`)
    .addFields(
      { name: `${sE} Stato`,     value: `**${S_LABEL[task.status] || task.status}**`,                 inline: true },
      { name: `${pE} Priorità`,  value: `**${task.priority.toUpperCase()}**`,                         inline: true },
      { name: `${cE} Tipo`,      value: `**${task.category.toUpperCase()}**`,                         inline: true },
      { name: '👤 Assegnato a',  value: task.assigned_to ? `<@${task.assigned_to}>` : '_—_',          inline: true },
      { name: '🕐 Creato',       value: tsF(task.created_at),                                          inline: true },
      { name: '\u200B',          value: '\u200B',                                                      inline: true },
    );

  if (task.description?.trim())
    embed.setDescription(`> ${task.description.trim().replace(/\n/g, '\n> ')}`);

  if (project)
    embed.addFields({ name: '📁 Progetto', value: `\`${project.code}\` — ${project.name}${project.client_name ? ` *(${project.client_name})*` : ''}` });

  if (task.tags?.trim())
    embed.addFields({ name: '🏷️ Tag', value: task.tags.split(',').map(t => `\`${t.trim()}\``).join(' ') });

  if (task.due_date)
    embed.addFields({ name: `⏰ Scadenza${isOverdue ? '  ⚠️ SCADUTO' : ''}`, value: `${tsF(task.due_date)}  ·  ${ts(task.due_date)}` });

  if (notes.length)
    embed.addFields({ name: '📝 Note recenti', value: notes.map(n => `${fmtActor(n.author_id)} *${ts(n.created_at)}*\n${n.content}`).join('\n\n').slice(0, 1020) });

  if (task.thread_id)
    embed.addFields({ name: '🧵 Thread', value: `<#${task.thread_id}>`, inline: true });

  embed.setFooter({ text: `E.C.H.O. Smart Dispatcher  ·  ${task.code}` }).setTimestamp();
  return embed;
}

function buildTaskButtons(task) {
  const closed = ['completed','cancelled'].includes(task.status);
  const taken  = task.status === 'in_progress';
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`task_take_${task.code}`).setLabel('Prendo in carico').setStyle(ButtonStyle.Primary).setEmoji('🙋').setDisabled(closed || taken),
      new ButtonBuilder().setCustomId(`task_done_${task.code}`).setLabel('Completato').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(closed),
      new ButtonBuilder().setCustomId(`task_block_${task.code}`).setLabel('Bloccato').setStyle(ButtonStyle.Danger).setEmoji('🔴').setDisabled(closed),
      new ButtonBuilder().setCustomId(`task_review_${task.code}`).setLabel('In Review').setStyle(ButtonStyle.Secondary).setEmoji('🔍').setDisabled(closed)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`task_cancel_${task.code}`).setLabel('Annulla').setStyle(ButtonStyle.Secondary).setEmoji('🚫').setDisabled(closed),
      new ButtonBuilder().setCustomId(`task_info_${task.code}`).setLabel('Dettagli & Note').setStyle(ButtonStyle.Secondary).setEmoji('📋')
    )
  ];
}

function buildTicketEmbed(ticket) {
  const svc = SERVICES.find(s => s.id === ticket.service_type);
  const statusColor = { open:COLOR.cyan, accepted:COLOR.green, rejected:COLOR.red, working:COLOR.amber, delivered:COLOR.gold };
  const statusLabel = { open:'🔵 In attesa', accepted:'✅ Accettato', rejected:'❌ Rifiutato', working:'🔧 In lavorazione', delivered:'📦 Consegnato' };
  return new EmbedBuilder()
    .setColor(statusColor[ticket.status] || COLOR.grey)
    .setTitle(`🎫  Ticket \`${ticket.code}\``)
    .setDescription(`> ${ticket.description.slice(0,300).replace(/\n/g,'\n> ')}`)
    .addFields(
      { name:'👤 Cliente',    value:`${ticket.tg_name||'N/A'}${ticket.tg_username?`\n@${ticket.tg_username}`:''}`, inline:true },
      { name:`${svc?.emoji||'🛎️'} Servizio`, value:svc?.label||ticket.service_type, inline:true },
      { name:'💰 Prezzo',     value:svc?.price||'Da concordare', inline:true },
      { name:'📊 Stato',      value:statusLabel[ticket.status]||ticket.status, inline:true },
      { name:'📅 Ricevuto',   value:`${tsF(ticket.created_at)}\n${ts(ticket.created_at)}`, inline:true },
      { name:'🔗 Task',       value:ticket.task_code?`\`${ticket.task_code}\``:'_Non creato_', inline:true },
    )
    .setFooter({ text:`E.C.H.O. Shop  ·  ${ticket.code}` }).setTimestamp();
}

function buildTicketButtons(ticket) {
  const open = ticket.status === 'open';
  const canWork = ['accepted','open'].includes(ticket.status);
  const done = ['delivered','rejected'].includes(ticket.status);
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tkt_accept_${ticket.code}`).setLabel('Accetta').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(!open),
    new ButtonBuilder().setCustomId(`tkt_reject_${ticket.code}`).setLabel('Rifiuta').setStyle(ButtonStyle.Danger).setEmoji('❌').setDisabled(!open),
    new ButtonBuilder().setCustomId(`tkt_working_${ticket.code}`).setLabel('In Lavorazione').setStyle(ButtonStyle.Primary).setEmoji('🔧').setDisabled(!canWork),
    new ButtonBuilder().setCustomId(`tkt_done_${ticket.code}`).setLabel('Consegnato').setStyle(ButtonStyle.Secondary).setEmoji('📦').setDisabled(done)
  )];
}

function buildProjectEmbed(project) {
  const all   = db.prepare('SELECT status FROM tasks WHERE project_id=?').all(project.id);
  const total = all.length;
  const done  = all.filter(t => t.status==='completed').length;
  const blk   = all.filter(t => t.status==='blocked').length;
  const open  = all.filter(t => t.status==='open').length;
  const prog  = all.filter(t => t.status==='in_progress').length;
  const sc    = { active:COLOR.green, completed:COLOR.gold, paused:COLOR.amber, cancelled:COLOR.red };
  return new EmbedBuilder()
    .setColor(sc[project.status]||COLOR.grey)
    .setTitle(`📁  \`${project.code}\` — ${project.name}`)
    .setDescription(project.description?`> ${project.description}`:'_Nessuna descrizione_')
    .addFields(
      { name:'👤 Cliente',     value:project.client_name||'_—_', inline:true },
      { name:'📊 Stato',       value:project.status.toUpperCase(), inline:true },
      { name:'📅 Creato',      value:tsD(project.created_at), inline:true },
      { name:'📈 Avanzamento', value:`\`${bar(done,total)}\`\n${done}/${total} completati`, inline:false },
      { name:'🔵 Aperti',      value:`${open}`,  inline:true },
      { name:'🟡 In Progress', value:`${prog}`,  inline:true },
      { name:'🔴 Bloccati',    value:`${blk}`,   inline:true },
    )
    .setFooter({ text:`E.C.H.O. Projects  ·  ${project.code}` }).setTimestamp();
}

// ══════════════════════════════════════════════════════════════
//  CORE DISCORD FUNCTIONS
// ══════════════════════════════════════════════════════════════
async function createTask(guild, channelId, title, description, createdBy, opts = {}) {
  const code      = nextCode('task');
  const priority  = opts.priority  || analyzePriority(`${title} ${description}`);
  const category  = opts.category  || analyzeCategory(`${title} ${description}`);
  const due_date  = opts.due_date !== undefined ? opts.due_date : parseDeadline(`${title} ${description}`);
  const projectId = opts.project_id || null;
  const tags      = opts.tags || '';
  const t         = now();

  stmt.insertTask.run(code, projectId, title, description, priority, category, 'open', createdBy, channelId, due_date, tags, t, t);

  const task    = stmt.getTask.get(code);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return task;

  const msg = await channel.send({ embeds: [buildTaskEmbed(task)], components: buildTaskButtons(task) });

  let threadId = null;
  try {
    const thread = await msg.startThread({
      name: `${code} — ${title.slice(0, 90)}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek
    });
    threadId = thread.id;
    await thread.send({
      embeds: [new EmbedBuilder()
        .setColor(COLOR[priority] || COLOR.blue)
        .setTitle(`🧵  Thread — ${code}`)
        .setDescription(`**${title}**\n\nThread di lavoro per aggiornamenti, note e discussioni.\n> Creato da ${fmtActor(createdBy)}  ·  ${tsF(t)}`)
        .addFields(
          { name:`${P_EMOJI[priority]} Priorità`, value:priority.toUpperCase(), inline:true },
          { name:`${C_EMOJI[category]} Tipo`,     value:category.toUpperCase(), inline:true },
        )
        .setFooter({ text:`E.C.H.O.  ·  ${code}` })
      ]
    });
  } catch (_) {}

  stmt.updateMsgId.run(threadId, msg.id, now(), code);

  if (due_date) {
    const ra = due_date - 3600;
    if (ra > now()) stmt.insertRemind.run(code, ra);
  }

  logEvent(guild, `📋 Task **${code}** creato da ${fmtActor(createdBy)}  ·  ${P_EMOJI[priority]} ${priority.toUpperCase()}  ·  ${title}`);
  return stmt.getTask.get(code);
}

async function updateTaskStatus(guild, code, newStatus, actorId) {
  const task = stmt.getTask.get(code);
  if (!task) return null;

  stmt.updateTask.run(newStatus, now(), code);
  const updated = stmt.getTask.get(code);

  // Aggiorna embed in canale
  const channel = await guild.channels.fetch(task.channel_id).catch(() => null);
  if (channel && task.message_id) {
    const msg = await channel.messages.fetch(task.message_id).catch(() => null);
    if (msg) msg.edit({ embeds: [buildTaskEmbed(updated)], components: buildTaskButtons(updated) }).catch(() => {});
  }

  // Notifica thread
  if (task.thread_id) {
    const thread = await guild.channels.fetch(task.thread_id).catch(() => null);
    if (thread) {
      thread.send({
        embeds: [new EmbedBuilder()
          .setColor(newStatus==='completed'?COLOR.green:newStatus==='blocked'?COLOR.red:COLOR.cyan)
          .setDescription(`${S_EMOJI[newStatus]}  **${S_LABEL[newStatus]||newStatus}**\nda ${fmtActor(actorId)}  ·  ${ts(now())}`)
        ]
      }).catch(() => {});
    }
  }

  logEvent(guild, `${S_EMOJI[newStatus]} Task **${code}** → **${(S_LABEL[newStatus]||newStatus).toUpperCase()}**  da ${fmtActor(actorId)}`);
  return updated;
}

async function assignTask(guild, code, userId, actorId) {
  const task = stmt.getTask.get(code);
  if (!task) return null;

  stmt.updateAssign.run(userId, 'in_progress', now(), code);
  const updated = stmt.getTask.get(code);

  const channel = await guild.channels.fetch(task.channel_id).catch(() => null);
  if (channel && task.message_id) {
    const msg = await channel.messages.fetch(task.message_id).catch(() => null);
    if (msg) msg.edit({ embeds: [buildTaskEmbed(updated)], components: buildTaskButtons(updated) }).catch(() => {});
  }

  if (task.thread_id) {
    const thread = await guild.channels.fetch(task.thread_id).catch(() => null);
    if (thread) {
      thread.send({
        embeds: [new EmbedBuilder()
          .setColor(COLOR.cyan)
          .setDescription(`👤  Task assegnato a <@${userId}>\nda ${fmtActor(actorId)}  ·  ${ts(now())}`)
        ]
      }).catch(() => {});
    }
  }

  logEvent(guild, `👤 Task **${code}** assegnato a <@${userId}>  da ${fmtActor(actorId)}`);
  return updated;
}

function logEvent(guild, message) {
  if (!CH_LOG || !guild) return;
  guild.channels.fetch(CH_LOG)
    .then(ch => ch?.send(`\`${new Date().toISOString().slice(0,19)}\`  ${message}`).catch(()=>{}))
    .catch(() => {});
}

// ══════════════════════════════════════════════════════════════
//  TICKET SYSTEM
// ══════════════════════════════════════════════════════════════
async function createTicketFromTelegram(guild, tgUser, serviceId, description) {
  const code = nextCode('ticket');
  const t    = now();

  stmt.insertTicket.run(code, String(tgUser.id), tgUser.username||null, tgUser.first_name||null, serviceId, description, t, t);
  const ticket   = stmt.getTicket.get(code);
  const targetCh = CH_TICKETS || CH_TASK_BOARD;
  const channel  = await guild.channels.fetch(targetCh).catch(() => null);

  let msgId = null, taskCode = null;
  if (channel) {
    const sndMsg = await channel.send({
      content: ROLE_OPS ? `<@&${ROLE_OPS}>  🎫 Nuova richiesta da Telegram!` : '🎫 Nuova richiesta da Telegram!',
      embeds:  [buildTicketEmbed(ticket)],
      components: buildTicketButtons(ticket),
      allowedMentions: { roles: ROLE_OPS ? [ROLE_OPS] : [] }
    });
    msgId = sndMsg.id;

    const svc  = SERVICES.find(s => s.id === serviceId);
    const task = await createTask(
      guild, CH_TASK_BOARD || targetCh,
      `[TKT] ${svc?.emoji||''} ${svc?.label||serviceId} — ${tgUser.first_name||tgUser.username||'Cliente'}`,
      description, 'telegram',
      { category:'request', priority:'high', tags:`ticket:${code}` }
    );
    taskCode = task.code;
  }

  stmt.setTicketMsg.run(msgId, taskCode, now(), code);
  logEvent(guild, `🎫 Nuovo ticket **${code}**  ·  ${serviceId}  ·  ${tgUser.first_name||tgUser.username||'N/A'}`);
  return stmt.getTicket.get(code);
}

async function updateTicketStatus(guild, ticketCode, newStatus, actorId) {
  const ticket = stmt.getTicket.get(ticketCode);
  if (!ticket) return null;

  stmt.updateTicket.run(newStatus, now(), ticketCode);

  const tgMessages = {
    accepted : '✅ La tua richiesta è stata *accettata*\\! Ti contatteremo a breve per definire i dettagli\\.',
    rejected : '❌ La tua richiesta non può essere gestita in questo momento\\. Scrivici per più informazioni\\.',
    working  : '🔧 Il tuo progetto è *in lavorazione*\\! Ti aggiorneremo sull\'avanzamento\\.',
    delivered: '📦 Progetto *completato e consegnato*\\! Grazie per aver scelto *E\\.C\\.H\\.O\\. Studio*\\.'
  };

  if (tgMessages[newStatus] && tgBot) {
    tgBot.sendMessage(ticket.tg_user_id, tgMessages[newStatus], { parse_mode:'MarkdownV2' }).catch(() => {});
  }

  logEvent(guild, `🎫 Ticket **${ticketCode}** → **${newStatus.toUpperCase()}**  da ${fmtActor(actorId)}`);
  return stmt.getTicket.get(ticketCode);
}

// ══════════════════════════════════════════════════════════════
//  TELEGRAM BOT — FIX COMPLETO
//  Problemi risolti:
//  1. Webhook vs Polling conflict → deleteWebhook prima di startPolling
//  2. Sessioni con Map invece di oggetto plain
//  3. Error handling con retry
//  4. Messaggi e handler separati per chiarezza
// ══════════════════════════════════════════════════════════════
let tgBot = null;
const tgSessions = new Map(); // chatId → { step, serviceId }

function initTelegram(guild) {
  if (!TG_TOKEN) {
    console.log('[E.C.H.O./TG] TELEGRAM_TOKEN non impostato — disabilitato.');
    return;
  }

  // Crea il bot SENZA polling inizialmente
  tgBot = new TelegramBot(TG_TOKEN, { polling: false });

  // FIX CRITICO: elimina qualsiasi webhook esistente prima di avviare polling
  // Se c'è un webhook attivo, polling silenziosamente non riceve nulla
  tgBot.deleteWebHook({ drop_pending_updates: true })
    .then(() => {
      console.log('[E.C.H.O./TG] Webhook eliminato. Avvio polling...');
      // Ora avvia polling con configurazione esplicita
      return tgBot.startPolling({
        interval: 300,
        autoStart: true,
        params: {
          timeout: 10,
          allowed_updates: ['message', 'callback_query']
        }
      });
    })
    .then(() => {
      console.log('[E.C.H.O./TG] Bot Telegram online e in ascolto.');
      _registerTelegramHandlers(guild);
    })
    .catch(err => {
      console.error('[E.C.H.O./TG] Errore inizializzazione:', err.message);
      // Prova comunque ad avviare polling
      tgBot.startPolling().catch(() => {});
      _registerTelegramHandlers(guild);
    });

  tgBot.on('polling_error', err => {
    // 409 = Conflict: c'è un'altra istanza — non crashare, solo logga
    if (err.code === 'ETELEGRAM' && err.message?.includes('409')) {
      console.warn('[E.C.H.O./TG] Conflict 409 — altra istanza attiva. In attesa...');
    } else {
      console.error('[E.C.H.O./TG] Polling error:', err.code || err.message);
    }
  });

  tgBot.on('error', err => {
    console.error('[E.C.H.O./TG] Error:', err.message);
  });
}

function _registerTelegramHandlers(guild) {

  // /start
  tgBot.onText(/\/start/, msg => {
    const name = esc(msg.from.first_name || 'amico');
    tgBot.sendMessage(msg.chat.id, [
      `👋 Benvenuto in *E\\.C\\.H\\.O\\. Studio*, ${name}\\!`,
      '',
      'Siamo specializzati in:',
      '• 🤖 Bot Discord su commissione',
      '• 🖥️ Setup server Discord professionali',
      '• ⚙️ Automazioni e sistemi personalizzati',
      '• 📦 Template e strumenti digitali',
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '📋 /servizi — Catalogo completo',
      '🎫 /richiedi — Fai una richiesta',
      '📦 /stato — Controlla i tuoi ticket',
      '❓ /help — Guida',
    ].join('\n'), { parse_mode:'MarkdownV2' }).catch(err => console.error('[TG] /start error:', err.message));
  });

  // /help
  tgBot.onText(/\/help/, msg => {
    tgBot.sendMessage(msg.chat.id, [
      '📖 *Guida E\\.C\\.H\\.O\\. Studio*',
      '',
      '`/start` \\— Messaggio di benvenuto',
      '`/servizi` \\— Catalogo servizi con prezzi',
      '`/richiedi` \\— Apri una nuova richiesta',
      '`/stato` \\— Controlla i tuoi ticket',
      '`/help` \\— Questa guida',
      '',
      '_Per domande puoi scrivere liberamente\\!_',
    ].join('\n'), { parse_mode:'MarkdownV2' }).catch(() => {});
  });

  // /chatid — per ottenere l'ID chat per TELEGRAM_LOG_CHAT
  tgBot.onText(/\/chatid/, msg => {
    tgBot.sendMessage(msg.chat.id, `🆔 Chat ID: \`${msg.chat.id}\``, { parse_mode:'MarkdownV2' }).catch(() => {});
  });

  // /servizi
  tgBot.onText(/\/servizi/, msg => {
    const lines = ['🛎️ *Servizi E\\.C\\.H\\.O\\. Studio*', '━━━━━━━━━━━━━━━━━━━━', ''];
    for (const s of SERVICES) {
      lines.push(`${esc(s.emoji)} *${esc(s.label)}*`);
      lines.push(`💰 Prezzo: \`${esc(s.price)}\``);
      lines.push('');
    }
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('_Usa /richiedi per iniziare_');
    tgBot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode:'MarkdownV2' }).catch(() => {});
  });

  // /richiedi
  tgBot.onText(/\/richiedi/, msg => {
    const chatId = msg.chat.id;
    tgSessions.set(chatId, { step:'select_service' });
    tgBot.sendMessage(chatId,
      '🎫 *Nuova Richiesta*\n\nSeleziona il servizio che ti interessa:',
      {
        parse_mode:'MarkdownV2',
        reply_markup: {
          inline_keyboard: SERVICES.map(s => ([{
            text: `${s.emoji} ${s.label}  —  ${s.price}`,
            callback_data: `svc_${s.id}`
          }]))
        }
      }
    ).catch(() => {});
  });

  // /stato
  tgBot.onText(/\/stato/, msg => {
    const chatId  = msg.chat.id;
    const tickets = db.prepare('SELECT * FROM tickets WHERE tg_user_id=? ORDER BY created_at DESC LIMIT 5').all(String(chatId));
    if (!tickets.length) {
      return tgBot.sendMessage(chatId,
        '📭 Nessun ticket trovato\\.\n\nUsa /richiedi per aprirne uno\\.', { parse_mode:'MarkdownV2' }
      ).catch(() => {});
    }
    const si = { open:'🔵', accepted:'✅', rejected:'❌', working:'🔧', delivered:'📦' };
    const lines = ['📦 *I tuoi ticket:*', ''];
    for (const t of tickets) {
      const svc = SERVICES.find(s => s.id === t.service_type);
      lines.push(`${si[t.status]||'❓'} \`${esc(t.code)}\``);
      lines.push(`   ${esc(svc?.emoji||'')} ${esc(svc?.label||t.service_type)}`);
      lines.push(`   Stato: *${esc(t.status.toUpperCase())}*`);
      lines.push('');
    }
    tgBot.sendMessage(chatId, lines.join('\n'), { parse_mode:'MarkdownV2' }).catch(() => {});
  });

  // Callback query — selezione servizio
  tgBot.on('callback_query', async query => {
    const chatId  = query.message?.chat?.id;
    if (!chatId) return;
    const session = tgSessions.get(chatId);
    tgBot.answerCallbackQuery(query.id).catch(() => {});

    if (query.data?.startsWith('svc_') && session?.step === 'select_service') {
      const serviceId = query.data.replace('svc_', '');
      const svc       = SERVICES.find(s => s.id === serviceId);
      if (!svc) return;
      tgSessions.set(chatId, { step:'write_description', serviceId });
      tgBot.sendMessage(chatId, [
        `${esc(svc.emoji)} *Servizio: ${esc(svc.label)}*`,
        `💰 Prezzo indicativo: \`${esc(svc.price)}\``,
        '',
        '📝 *Descrivi la tua richiesta:*',
        '_Includi tutti i dettagli utili: cosa ti serve, preferenze, scadenze\\._',
      ].join('\n'), { parse_mode:'MarkdownV2' }).catch(() => {});
    }
  });

  // Messaggi liberi
  tgBot.on('message', async msg => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId  = msg.chat.id;
    const session = tgSessions.get(chatId);

    // Step: descrizione ticket
    if (session?.step === 'write_description') {
      tgSessions.delete(chatId);
      tgBot.sendMessage(chatId, '⏳ Invio richiesta al team\\.\\.\\.', { parse_mode:'MarkdownV2' }).catch(() => {});

      try {
        const ticket = await createTicketFromTelegram(guild, msg.from, session.serviceId, msg.text);
        tgBot.sendMessage(chatId, [
          '🎫 *Richiesta inviata con successo\\!*',
          '',
          `📋 Codice: \`${esc(ticket.code)}\``,
          '',
          'Il team analizzerà la tua richiesta e ti risponderà il prima possibile\\.',
          'Usa /stato per monitorare l\'avanzamento\\.',
        ].join('\n'), { parse_mode:'MarkdownV2' }).catch(() => {});

        if (TG_LOG_CHAT) {
          const svc = SERVICES.find(s => s.id === session.serviceId);
          tgBot.sendMessage(TG_LOG_CHAT, [
            `🎫 *Nuovo ticket* \`${esc(ticket.code)}\``,
            `👤 ${esc(msg.from.first_name||'')}${msg.from.username?` \\(@${esc(msg.from.username)}\\)`:''}`,
            `${esc(svc?.emoji||'')} ${esc(svc?.label||session.serviceId)}`,
            `📝 ${esc(msg.text.slice(0,200))}`,
          ].join('\n'), { parse_mode:'MarkdownV2' }).catch(() => {});
        }
      } catch (err) {
        console.error('[E.C.H.O./TG] createTicket error:', err.message);
        tgBot.sendMessage(chatId, '⚠️ Errore temporaneo\\. Riprova tra qualche minuto\\.', { parse_mode:'MarkdownV2' }).catch(() => {});
      }
      return;
    }

    // Risposta generica
    tgBot.sendMessage(chatId, [
      '👋 Ciao\\! Sono il bot di *E\\.C\\.H\\.O\\. Studio*\\.',
      '',
      '📋 /servizi — Vedi cosa offriamo',
      '🎫 /richiedi — Apri una richiesta',
      '📦 /stato — Controlla i tuoi ticket',
    ].join('\n'), { parse_mode:'MarkdownV2' }).catch(() => {});
  });
}

// ══════════════════════════════════════════════════════════════
//  SLASH COMMANDS
// ══════════════════════════════════════════════════════════════
const commands = [
  new SlashCommandBuilder().setName('task').setDescription('Gestione task E.C.H.O.')
    .addSubcommand(s => s.setName('create').setDescription('Crea un nuovo task')
      .addStringOption(o => o.setName('titolo').setDescription('Titolo').setRequired(true))
      .addStringOption(o => o.setName('descrizione').setDescription('Descrizione'))
      .addStringOption(o => o.setName('priorita').setDescription('Priorità').addChoices(
        {name:'🚨 Critical',value:'critical'},{name:'🔥 High',value:'high'},
        {name:'❗ Medium',value:'medium'},{name:'⏳ Low',value:'low'}
      ))
      .addStringOption(o => o.setName('categoria').setDescription('Categoria').addChoices(
        {name:'🐛 Bug',value:'bug'},{name:'✨ Feature',value:'feature'},
        {name:'📋 Task',value:'task'},{name:'📨 Request',value:'request'},
        {name:'⚡ Urgent',value:'urgent'},{name:'📝 Docs',value:'docs'}
      ))
      .addUserOption(o => o.setName('assegna').setDescription('Assegna subito'))
      .addStringOption(o => o.setName('scadenza').setDescription('"domani", "in 3 giorni", "in 5 ore"'))
      .addStringOption(o => o.setName('progetto').setDescription('Codice progetto (P-001)'))
      .addStringOption(o => o.setName('tag').setDescription('Tag separati da virgola'))
    )
    .addSubcommand(s => s.setName('list').setDescription('Lista task')
      .addStringOption(o => o.setName('filtro').setDescription('Stato').addChoices(
        {name:'🔵 Open',value:'open'},{name:'🟡 In Progress',value:'in_progress'},
        {name:'🔴 Blocked',value:'blocked'},{name:'🔍 Review',value:'reviewing'},
        {name:'✅ Completed',value:'completed'},{name:'📋 Tutti',value:'all'}
      ))
      .addUserOption(o => o.setName('utente').setDescription('Filtra per membro'))
      .addStringOption(o => o.setName('progetto').setDescription('Filtra per progetto'))
    )
    .addSubcommand(s => s.setName('assign').setDescription('Assegna un task')
      .addStringOption(o => o.setName('codice').setDescription('Codice (T-001)').setRequired(true))
      .addUserOption(o => o.setName('utente').setDescription('Membro').setRequired(true))
    )
    .addSubcommand(s => s.setName('done').setDescription('Completa un task')
      .addStringOption(o => o.setName('codice').setDescription('Codice task').setRequired(true))
    )
    .addSubcommand(s => s.setName('info').setDescription('Dettagli di un task')
      .addStringOption(o => o.setName('codice').setDescription('Codice task').setRequired(true))
    )
    .addSubcommand(s => s.setName('note').setDescription('Aggiungi una nota')
      .addStringOption(o => o.setName('codice').setDescription('Codice task').setRequired(true))
      .addStringOption(o => o.setName('testo').setDescription('Testo nota').setRequired(true))
    )
    .addSubcommand(s => s.setName('deadline').setDescription('Imposta scadenza')
      .addStringOption(o => o.setName('codice').setDescription('Codice task').setRequired(true))
      .addStringOption(o => o.setName('scadenza').setDescription('"domani", "in 2 giorni"').setRequired(true))
    )
    .addSubcommand(s => s.setName('priority').setDescription('Cambia priorità')
      .addStringOption(o => o.setName('codice').setDescription('Codice task').setRequired(true))
      .addStringOption(o => o.setName('priorita').setDescription('Nuova priorità').setRequired(true).addChoices(
        {name:'🚨 Critical',value:'critical'},{name:'🔥 High',value:'high'},
        {name:'❗ Medium',value:'medium'},{name:'⏳ Low',value:'low'}
      ))
    )
    .addSubcommand(s => s.setName('search').setDescription('Cerca task')
      .addStringOption(o => o.setName('query').setDescription('Parola chiave').setRequired(true))
    )
    .addSubcommand(s => s.setName('stats').setDescription('Statistiche complete'))
    .addSubcommand(s => s.setName('digest').setDescription('Digest manuale')),

  new SlashCommandBuilder().setName('project').setDescription('Gestione progetti')
    .addSubcommand(s => s.setName('create').setDescription('Crea un progetto')
      .addStringOption(o => o.setName('nome').setDescription('Nome progetto').setRequired(true))
      .addStringOption(o => o.setName('cliente').setDescription('Nome cliente'))
      .addStringOption(o => o.setName('descrizione').setDescription('Descrizione'))
    )
    .addSubcommand(s => s.setName('list').setDescription('Lista progetti attivi'))
    .addSubcommand(s => s.setName('info').setDescription('Dettagli progetto')
      .addStringOption(o => o.setName('codice').setDescription('Codice (P-001)').setRequired(true))
    )
    .addSubcommand(s => s.setName('report').setDescription('Report completo')
      .addStringOption(o => o.setName('codice').setDescription('Codice progetto').setRequired(true))
    )
    .addSubcommand(s => s.setName('close').setDescription('Chiudi un progetto')
      .addStringOption(o => o.setName('codice').setDescription('Codice progetto').setRequired(true))
    ),

  new SlashCommandBuilder().setName('ticket').setDescription('Gestione ticket clienti')
    .addSubcommand(s => s.setName('list').setDescription('Lista ticket'))
    .addSubcommand(s => s.setName('info').setDescription('Dettagli ticket')
      .addStringOption(o => o.setName('codice').setDescription('Codice ticket').setRequired(true))
    )
    .addSubcommand(s => s.setName('create').setDescription('Crea ticket manuale')
      .addStringOption(o => o.setName('servizio').setDescription('Tipo servizio').setRequired(true).addChoices(
        ...SERVICES.map(s => ({ name:`${s.emoji} ${s.label}`, value:s.id }))
      ))
      .addStringOption(o => o.setName('descrizione').setDescription('Descrizione').setRequired(true))
      .addStringOption(o => o.setName('cliente').setDescription('Nome cliente'))
    ),

  new SlashCommandBuilder().setName('echo').setDescription('Info sistema E.C.H.O.')
    .addSubcommand(s => s.setName('status').setDescription('Stato del sistema'))
    .addSubcommand(s => s.setName('help').setDescription('Guida comandi'))
    .addSubcommand(s => s.setName('ping').setDescription('Test latenza')),
];

async function registerCommands() {
  const rest = new REST({ version:'10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
    console.log('[E.C.H.O.] Comandi slash registrati.');
  } catch (e) {
    console.error('[E.C.H.O.] Errore registrazione comandi:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  DISCORD CLIENT
// ══════════════════════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.on('error', err => console.error('[E.C.H.O./Discord] Client error:', err.message));

client.once('ready', async () => {
  console.log(`[E.C.H.O.] Discord online: ${client.user.tag}`);
  console.log(`[E.C.H.O.] DB: ${DB_PATH}`);
  client.user.setActivity('⚙️ E.O.N.D. Core  ·  /task', { type: 4 });
  await registerCommands();
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error('[E.C.H.O.] Guild non trovata! Controlla DISCORD_GUILD_ID');
    return;
  }
  initTelegram(guild);
  startCronJobs(guild);
  startWebhookServer();
});

// ── Auto-task dai canali monitorati ──────────────────────────
const MONITORED = () => [CH_TASK_BOARD, CH_BUG_TRACKER, CH_DEV_REQUESTS].filter(Boolean);

client.on('messageCreate', async msg => {
  if (msg.author.bot)                       return;
  if (!MONITORED().includes(msg.channelId)) return;
  if (msg.channel.isThread())               return;
  if (msg.content.startsWith('/'))          return;
  if (msg.content.length < 8)              return;
  const title = msg.content.split('\n')[0].slice(0, 200);
  const desc  = msg.content.split('\n').slice(1).join('\n').slice(0, 1000);
  await createTask(msg.guild, msg.channelId, title, desc, msg.author.id);
  await msg.delete().catch(() => {});
});

// ── Reazioni rapide ──────────────────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  const task = stmt.taskMsgId.get(reaction.message.id);
  if (!task) return;
  const map = { '✅':'completed', '🔴':'blocked', '🚫':'cancelled', '🔍':'reviewing' };
  const ns  = map[reaction.emoji.name];
  if (ns) updateTaskStatus(reaction.message.guild, task.code, ns, user.id);
});

// ══════════════════════════════════════════════════════════════
//  INTERACTION HANDLER
// ══════════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
  const guild = interaction.guild;

  // ── BOTTONI ──────────────────────────────────────────────
  if (interaction.isButton()) {
    // FIX 10062: deferReply IMMEDIATAMENTE — prima di qualsiasi await
    const deferred = await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => false);
    if (deferred === false) return; // interazione già scaduta

    const parts = interaction.customId.split('_');
    const ns    = parts[0]; // 'task' | 'tkt'
    const act   = parts[1];
    const code  = parts.slice(2).join('_');

    // Bottoni ticket
    if (ns === 'tkt') {
      const ticket = stmt.getTicket.get(code);
      if (!ticket) return interaction.editReply({ content:'❌ Ticket non trovato.' });
      const sm = { accept:'accepted', reject:'rejected', working:'working', done:'delivered' };
      const ns2 = sm[act];
      if (!ns2) return interaction.editReply({ content:'❓ Azione non riconosciuta.' });
      await updateTicketStatus(guild, code, ns2, interaction.user.id);
      // Aggiorna embed Discord
      const tch = CH_TICKETS || CH_TASK_BOARD;
      const ch  = await guild.channels.fetch(tch).catch(() => null);
      if (ch && ticket.discord_msg) {
        const msg = await ch.messages.fetch(ticket.discord_msg).catch(() => null);
        if (msg) {
          const upd = stmt.getTicket.get(code);
          msg.edit({ embeds:[buildTicketEmbed(upd)], components:buildTicketButtons(upd) }).catch(() => {});
        }
      }
      return interaction.editReply({ content:`✅ Ticket **${code}** → **${ns2.toUpperCase()}**.` });
    }

    // Bottoni task
    const task = stmt.getTask.get(code);
    if (!task) return interaction.editReply({ content:'❌ Task non trovato.' });

    if (act === 'take') {
      if (task.assigned_to === interaction.user.id)
        return interaction.editReply({ content:'⚠️ Sei già assegnato a questo task.' });
      await assignTask(guild, code, interaction.user.id, interaction.user.id);
      return interaction.editReply({ content:`✅ Hai preso in carico **${code}**.` });
    }
    const statusMap = { done:'completed', block:'blocked', review:'reviewing', cancel:'cancelled' };
    const newStatus = statusMap[act];
    if (newStatus) {
      await updateTaskStatus(guild, code, newStatus, interaction.user.id);
      const icons = { completed:'✅', blocked:'🔴', reviewing:'🔍', cancelled:'🚫' };
      return interaction.editReply({ content:`${icons[newStatus]} **${code}** → **${newStatus.toUpperCase()}**.` });
    }
    if (act === 'info') {
      const t     = stmt.getTask.get(code);
      const notes = stmt.getNotes.all(code);
      return interaction.editReply({ embeds:[buildTaskEmbed(t, notes)] });
    }
    return interaction.editReply({ content:'❓ Azione non riconosciuta.' });
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName, options } = interaction;

  // ══════════════════════════════════════════════════════════
  //  /echo
  // ══════════════════════════════════════════════════════════
  if (commandName === 'echo') {
    const sub = options.getSubcommand();

    if (sub === 'ping') {
      const lat = Date.now() - interaction.createdTimestamp;
      return interaction.reply({
        ...EPH,
        embeds: [new EmbedBuilder()
          .setColor(lat < 100 ? COLOR.green : lat < 250 ? COLOR.amber : COLOR.red)
          .setTitle('🏓  Pong!')
          .addFields(
            { name:'⚡ Latenza API', value:`\`${lat}ms\``,           inline:true },
            { name:'💓 WebSocket',  value:`\`${client.ws.ping}ms\``, inline:true },
          )
          .setFooter({ text:'E.C.H.O. v3.1' })
        ]
      });
    }

    if (sub === 'status') {
      const q = s => db.prepare(s).get().c;
      const tasks  = q('SELECT COUNT(*) as c FROM tasks');
      const open   = q("SELECT COUNT(*) as c FROM tasks WHERE status='open'");
      const prog   = q("SELECT COUNT(*) as c FROM tasks WHERE status='in_progress'");
      const done   = q("SELECT COUNT(*) as c FROM tasks WHERE status='completed'");
      const blk    = q("SELECT COUNT(*) as c FROM tasks WHERE status='blocked'");
      const projs  = q("SELECT COUNT(*) as c FROM projects WHERE status='active'");
      const tkts   = q("SELECT COUNT(*) as c FROM tickets WHERE status='open'");
      const up     = Math.floor(client.uptime/1000);
      const [h,m,s] = [Math.floor(up/3600), Math.floor((up%3600)/60), up%60];
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLOR.cyan)
          .setTitle('⚙️  E.C.H.O. — System Status')
          .setDescription('```\nE.C.H.O. Smart Dispatcher v3.1\nE.O.N.D. Core — Online\n```')
          .addFields(
            { name:'📋 Task totali',    value:`\`${tasks}\``,  inline:true },
            { name:'🔵 Aperti',         value:`\`${open}\``,   inline:true },
            { name:'🟡 In Progress',    value:`\`${prog}\``,   inline:true },
            { name:'🔴 Bloccati',       value:`\`${blk}\``,    inline:true },
            { name:'✅ Completati',      value:`\`${done}\``,   inline:true },
            { name:'📈 Avanzamento',    value:`\`${bar(done,tasks)}\``, inline:false },
            { name:'📁 Progetti',       value:`\`${projs}\``,  inline:true },
            { name:'🎫 Ticket aperti',  value:`\`${tkts}\``,   inline:true },
            { name:'📱 Telegram',       value:TG_TOKEN?'`✅ Online`':'`❌ Off`', inline:true },
            { name:'🤖 Uptime',         value:`\`${h}h ${m}m ${s}s\``, inline:true },
          )
          .setFooter({ text:`E.C.H.O. v3.1  ·  DB: ${path.basename(DB_PATH)}` })
          .setTimestamp()
        ]
      });
    }

    if (sub === 'help') {
      return interaction.reply({
        ...EPH,
        embeds: [new EmbedBuilder()
          .setColor(COLOR.gold)
          .setTitle('📖  E.C.H.O. — Guida v3.1')
          .setDescription('Scrivi nei canali monitorati per creare task automaticamente, oppure usa `/task create`.')
          .addFields(
            { name:'📋 /task',    value:'`create` `list` `assign` `done` `info` `note` `deadline` `priority` `search` `stats` `digest`' },
            { name:'📁 /project', value:'`create` `list` `info` `report` `close`' },
            { name:'🎫 /ticket',  value:'`list` `info` `create`' },
            { name:'📱 Telegram', value:'`@echo_std_bot` — `/servizi` `/richiedi` `/stato`' },
            { name:'⚡ Reazioni', value:'`✅` Completa  ·  `🔴` Blocca  ·  `🚫` Annulla  ·  `🔍` Review' },
            { name:'🔧 Sistema',  value:'`/echo ping`  `/echo status`  `/echo help`' },
          )
          .setFooter({ text:'E.C.H.O. Smart Dispatcher v3.1' })
        ]
      });
    }
  }

  // ══════════════════════════════════════════════════════════
  //  /project
  // ══════════════════════════════════════════════════════════
  if (commandName === 'project') {
    const sub = options.getSubcommand();

    if (sub === 'create') {
      const nome    = options.getString('nome');
      const cliente = options.getString('cliente') || null;
      const desc    = options.getString('descrizione') || '';
      const code    = nextCode('project');
      const t       = now();
      stmt.insertProject.run(code, nome, desc, cliente, interaction.user.id, 'active', t, t);
      const project = db.prepare('SELECT * FROM projects WHERE code=?').get(code);
      logEvent(guild, `📁 Progetto **${code}** "${nome}" creato da <@${interaction.user.id}>`);
      return interaction.reply({ embeds:[buildProjectEmbed(project)] });
    }

    if (sub === 'list') {
      const projects = db.prepare("SELECT * FROM projects WHERE status='active' ORDER BY created_at DESC").all();
      if (!projects.length) return interaction.reply({ ...EPH, content:'📭 Nessun progetto attivo.' });
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLOR.green)
          .setTitle('📁  Progetti Attivi')
          .setDescription(projects.map(p => {
            const t = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE project_id=?').get(p.id).c;
            const d = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE project_id=? AND status='completed'").get(p.id).c;
            return `**\`${p.code}\`** ${p.name}${p.client_name?`  ·  *${p.client_name}*`:''}\n\`${bar(d,t,8)}\`  ·  ${t} task`;
          }).join('\n\n'))
          .setFooter({ text:`${projects.length} progetti` })
        ]
      });
    }

    if (sub === 'info') {
      const code    = options.getString('codice').toUpperCase();
      const project = stmt.getProject.get(code);
      if (!project) return interaction.reply({ ...EPH, content:`❌ Progetto \`${code}\` non trovato.` });
      return interaction.reply({ embeds:[buildProjectEmbed(project)] });
    }

    if (sub === 'report') {
      await interaction.deferReply();
      const code    = options.getString('codice').toUpperCase();
      const project = stmt.getProject.get(code);
      if (!project) return interaction.editReply({ content:`❌ Progetto \`${code}\` non trovato.` });
      const tasks  = db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at ASC').all(project.id);
      const done   = tasks.filter(t=>t.status==='completed').length;
      const embed  = new EmbedBuilder()
        .setColor(COLOR.gold)
        .setTitle(`📊  Report — \`${project.code}\` · ${project.name}`)
        .setDescription(project.description?`> ${project.description}`:'_Nessuna descrizione_')
        .addFields(
          { name:'👤 Cliente',     value:project.client_name||'—',                           inline:true },
          { name:'📊 Stato',       value:project.status.toUpperCase(),                        inline:true },
          { name:'📅 Creato',      value:tsD(project.created_at),                             inline:true },
          { name:'📈 Avanzamento', value:`\`${bar(done,tasks.length)}\`\n${done}/${tasks.length} completati`, inline:false },
        );
      if (tasks.length) {
        embed.addFields({ name:'📋 Task',
          value:tasks.slice(0,15).map(t=>`${S_EMOJI[t.status]} \`${t.code}\` ${t.title.slice(0,50)}${t.assigned_to?` → <@${t.assigned_to}>`:''}`).join('\n').slice(0,1024)
        });
      }
      embed.setFooter({ text:`E.C.H.O. Projects  ·  ${project.code}` }).setTimestamp();
      return interaction.editReply({ embeds:[embed] });
    }

    if (sub === 'close') {
      const code    = options.getString('codice').toUpperCase();
      const project = stmt.getProject.get(code);
      if (!project) return interaction.reply({ ...EPH, content:`❌ Progetto \`${code}\` non trovato.` });
      stmt.closeProject.run('completed', now(), code);
      logEvent(guild, `📁 Progetto **${code}** chiuso da <@${interaction.user.id}>`);
      return interaction.reply({ content:`✅ Progetto **${code}** chiuso.` });
    }
  }

  // ══════════════════════════════════════════════════════════
  //  /ticket
  // ══════════════════════════════════════════════════════════
  if (commandName === 'ticket') {
    const sub = options.getSubcommand();

    if (sub === 'list') {
      const tickets = db.prepare('SELECT * FROM tickets ORDER BY created_at DESC LIMIT 15').all();
      if (!tickets.length) return interaction.reply({ ...EPH, content:'📭 Nessun ticket.' });
      const si = { open:'🔵', accepted:'✅', rejected:'❌', working:'🔧', delivered:'📦' };
      return interaction.reply({
        ...EPH,
        embeds:[new EmbedBuilder()
          .setColor(COLOR.gold)
          .setTitle('🎫  Ticket')
          .setDescription(tickets.map(t => {
            const svc = SERVICES.find(s=>s.id===t.service_type);
            return `${si[t.status]||'❓'} **\`${t.code}\`**  ${svc?.emoji||''} ${svc?.label||t.service_type}  ·  ${t.tg_name||t.tg_username||'N/A'}`;
          }).join('\n'))
          .setFooter({ text:`${tickets.length} ticket` })
        ]
      });
    }

    if (sub === 'info') {
      const code   = options.getString('codice').toUpperCase();
      const ticket = stmt.getTicket.get(code);
      if (!ticket) return interaction.reply({ ...EPH, content:`❌ Ticket \`${code}\` non trovato.` });
      return interaction.reply({ ...EPH, embeds:[buildTicketEmbed(ticket)] });
    }

    if (sub === 'create') {
      await interaction.deferReply({ flags:MessageFlags.Ephemeral });
      const serviceId = options.getString('servizio');
      const desc      = options.getString('descrizione');
      const cliente   = options.getString('cliente') || interaction.user.username;
      const ticket    = await createTicketFromTelegram(guild, { id:interaction.user.id, username:interaction.user.username, first_name:cliente }, serviceId, desc);
      return interaction.editReply({ content:`✅ Ticket **${ticket.code}** creato.` });
    }
  }

  // ══════════════════════════════════════════════════════════
  //  /task
  // ══════════════════════════════════════════════════════════
  if (commandName === 'task') {
    const sub = options.getSubcommand();

    if (sub === 'create') {
      await interaction.deferReply({ flags:MessageFlags.Ephemeral });
      const title    = options.getString('titolo');
      const desc     = options.getString('descrizione') || '';
      const priority = options.getString('priorita')    || undefined;
      const category = options.getString('categoria')   || undefined;
      const assegna  = options.getUser('assegna');
      const due_date = parseDeadline(options.getString('scadenza') || '');
      const tagStr   = options.getString('tag') || '';
      const progCod  = options.getString('progetto')?.toUpperCase();
      let projectId  = null;
      if (progCod) {
        const p = stmt.getProject.get(progCod);
        projectId = p?.id || null;
      }
      const task = await createTask(guild, CH_TASK_BOARD||interaction.channelId, title, desc, interaction.user.id, { priority, category, due_date, project_id:projectId, tags:tagStr });
      if (assegna) await assignTask(guild, task.code, assegna.id, interaction.user.id);
      return interaction.editReply({ content:`✅ Task **${task.code}** creato${assegna?` · assegnato a <@${assegna.id}>`:''}.` });
    }

    if (sub === 'list') {
      const filtro  = options.getString('filtro') || 'open';
      const utente  = options.getUser('utente');
      const progCod = options.getString('progetto')?.toUpperCase();
      const conds   = [], params = [];
      if (filtro !== 'all') { conds.push('t.status=?'); params.push(filtro); }
      if (utente)           { conds.push('t.assigned_to=?'); params.push(utente.id); }
      if (progCod) {
        const p = stmt.getProject.get(progCod);
        if (p) { conds.push('t.project_id=?'); params.push(p.id); }
      }
      const where = conds.length ? ' WHERE '+conds.join(' AND ') : '';
      const tasks = db.prepare(`SELECT t.*,p.code AS proj_code FROM tasks t LEFT JOIN projects p ON t.project_id=p.id${where} ORDER BY t.created_at DESC LIMIT 20`).all(...params);
      if (!tasks.length) return interaction.reply({ ...EPH, content:'📭 Nessun task trovato.' });
      return interaction.reply({
        ...EPH,
        embeds:[new EmbedBuilder()
          .setColor(COLOR.blue)
          .setTitle(`📋  Task — ${filtro==='all'?'Tutti':(S_LABEL[filtro]||filtro.toUpperCase())}`)
          .setDescription(tasks.map(t =>
            `${S_EMOJI[t.status]} ${P_EMOJI[t.priority]} **\`${t.code}\`**${t.proj_code?` \`[${t.proj_code}]\``:''} ${t.title.slice(0,50)}` +
            (t.assigned_to?`  →  <@${t.assigned_to}>`:'') +
            (t.due_date&&t.due_date<now()&&!['completed','cancelled'].includes(t.status)?' ⚠️':
             t.due_date&&t.due_date>now()?`  ⏰${ts(t.due_date)}`:'')
          ).join('\n'))
          .setFooter({ text:`${tasks.length} task trovati` })
        ]
      });
    }

    if (sub === 'assign') {
      const code   = options.getString('codice').toUpperCase();
      const utente = options.getUser('utente');
      const task   = await assignTask(guild, code, utente.id, interaction.user.id);
      if (!task) return interaction.reply({ ...EPH, content:`❌ Task \`${code}\` non trovato.` });
      return interaction.reply({ content:`✅ Task **${code}** assegnato a <@${utente.id}>.` });
    }

    if (sub === 'done') {
      const code = options.getString('codice').toUpperCase();
      const task = await updateTaskStatus(guild, code, 'completed', interaction.user.id);
      if (!task) return interaction.reply({ ...EPH, content:`❌ Task \`${code}\` non trovato.` });
      return interaction.reply({ content:`✅ Task **${code}** completato.` });
    }

    if (sub === 'info') {
      const code  = options.getString('codice').toUpperCase();
      const task  = stmt.getTask.get(code);
      if (!task) return interaction.reply({ ...EPH, content:`❌ Task \`${code}\` non trovato.` });
      return interaction.reply({ ...EPH, embeds:[buildTaskEmbed(task, stmt.getNotes.all(code))] });
    }

    if (sub === 'note') {
      const code  = options.getString('codice').toUpperCase();
      const testo = options.getString('testo');
      const task  = stmt.getTask.get(code);
      if (!task) return interaction.reply({ ...EPH, content:`❌ Task \`${code}\` non trovato.` });
      stmt.insertNote.run(code, interaction.user.id, testo, now());
      if (task.thread_id) {
        guild.channels.fetch(task.thread_id)
          .then(thread => thread?.send({
            embeds:[new EmbedBuilder().setColor(COLOR.blue).setDescription(`📝 **Nota** da <@${interaction.user.id}>  ·  ${ts(now())}\n> ${testo}`)]
          }).catch(()=>{}))
          .catch(()=>{});
      }
      logEvent(guild, `📝 Nota su **${code}** da <@${interaction.user.id}>`);
      return interaction.reply({ ...EPH, content:`✅ Nota aggiunta a **${code}**.` });
    }

    if (sub === 'deadline') {
      const code     = options.getString('codice').toUpperCase();
      const due_date = parseDeadline(options.getString('scadenza'));
      if (!due_date) return interaction.reply({ ...EPH, content:'❌ Formato non riconosciuto. Usa: "domani", "in 3 giorni", "in 5 ore".' });
      const task = stmt.getTask.get(code);
      if (!task) return interaction.reply({ ...EPH, content:`❌ Task \`${code}\` non trovato.` });
      stmt.updateDue.run(due_date, now(), code);
      stmt.delReminders.run(code);
      const ra = due_date - 3600;
      if (ra > now()) stmt.insertRemind.run(code, ra);
      const upd = stmt.getTask.get(code);
      const ch  = await guild.channels.fetch(task.channel_id).catch(()=>null);
      if (ch && task.message_id) {
        const msg = await ch.messages.fetch(task.message_id).catch(()=>null);
        if (msg) msg.edit({ embeds:[buildTaskEmbed(upd)], components:buildTaskButtons(upd) }).catch(()=>{});
      }
      return interaction.reply({ ...EPH, content:`⏰ Scadenza di **${code}** → ${tsF(due_date)}  ·  ${ts(due_date)}.` });
    }

    if (sub === 'priority') {
      const code     = options.getString('codice').toUpperCase();
      const priorita = options.getString('priorita');
      const task     = stmt.getTask.get(code);
      if (!task) return interaction.reply({ ...EPH, content:`❌ Task \`${code}\` non trovato.` });
      stmt.updatePrio.run(priorita, now(), code);
      const upd = stmt.getTask.get(code);
      const ch  = await guild.channels.fetch(task.channel_id).catch(()=>null);
      if (ch && task.message_id) {
        const msg = await ch.messages.fetch(task.message_id).catch(()=>null);
        if (msg) msg.edit({ embeds:[buildTaskEmbed(upd)], components:buildTaskButtons(upd) }).catch(()=>{});
      }
      logEvent(guild, `${P_EMOJI[priorita]} Priorità **${code}** → **${priorita.toUpperCase()}** da <@${interaction.user.id}>`);
      return interaction.reply({ content:`${P_EMOJI[priorita]} Priorità di **${code}** → **${priorita.toUpperCase()}**.` });
    }

    if (sub === 'search') {
      const q     = `%${options.getString('query').toLowerCase()}%`;
      const tasks = db.prepare(`SELECT * FROM tasks WHERE LOWER(title) LIKE ? OR LOWER(code) LIKE ? OR LOWER(tags) LIKE ? ORDER BY created_at DESC LIMIT 15`).all(q,q,q);
      if (!tasks.length) return interaction.reply({ ...EPH, content:`🔍 Nessun risultato.` });
      return interaction.reply({
        ...EPH,
        embeds:[new EmbedBuilder()
          .setColor(COLOR.purple)
          .setTitle(`🔍  Risultati`)
          .setDescription(tasks.map(t=>`${S_EMOJI[t.status]} ${P_EMOJI[t.priority]} **\`${t.code}\`** ${t.title.slice(0,60)}`).join('\n'))
          .setFooter({ text:`${tasks.length} risultati` })
        ]
      });
    }

    if (sub === 'stats') {
      const q    = s => db.prepare(s).get().c;
      const now_ = now();
      const s = {
        total    : q('SELECT COUNT(*) as c FROM tasks'),
        open     : q("SELECT COUNT(*) as c FROM tasks WHERE status='open'"),
        inprog   : q("SELECT COUNT(*) as c FROM tasks WHERE status='in_progress'"),
        blocked  : q("SELECT COUNT(*) as c FROM tasks WHERE status='blocked'"),
        reviewing: q("SELECT COUNT(*) as c FROM tasks WHERE status='reviewing'"),
        completed: q("SELECT COUNT(*) as c FROM tasks WHERE status='completed'"),
        cancelled: q("SELECT COUNT(*) as c FROM tasks WHERE status='cancelled'"),
        critical : q("SELECT COUNT(*) as c FROM tasks WHERE priority IN ('critical','high') AND status NOT IN ('completed','cancelled')"),
        overdue  : db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE due_date < ${now_} AND status NOT IN ('completed','cancelled')`).get().c,
        projects : q("SELECT COUNT(*) as c FROM projects WHERE status='active'"),
        tickets  : q("SELECT COUNT(*) as c FROM tickets WHERE status='open'"),
      };
      const top = db.prepare("SELECT assigned_to, COUNT(*) as cnt FROM tasks WHERE assigned_to IS NOT NULL AND status NOT IN ('completed','cancelled') GROUP BY assigned_to ORDER BY cnt DESC LIMIT 1").get();
      return interaction.reply({
        embeds:[new EmbedBuilder()
          .setColor(COLOR.gold)
          .setTitle('📊  E.C.H.O. — Statistiche')
          .addFields(
            { name:'📈 Avanzamento',  value:`\`${bar(s.completed,s.total)}\``, inline:false },
            { name:'📋 Totali',       value:`\`${s.total}\``,     inline:true },
            { name:'🔵 Aperti',       value:`\`${s.open}\``,      inline:true },
            { name:'🟡 In Progress',  value:`\`${s.inprog}\``,    inline:true },
            { name:'🔍 In Review',    value:`\`${s.reviewing}\``, inline:true },
            { name:'🔴 Bloccati',     value:`\`${s.blocked}\``,   inline:true },
            { name:'✅ Completati',    value:`\`${s.completed}\``, inline:true },
            { name:'🚫 Annullati',    value:`\`${s.cancelled}\``, inline:true },
            { name:'🚨 Critici',      value:`\`${s.critical}\``,  inline:true },
            { name:'⚠️ Scaduti',      value:`\`${s.overdue}\``,   inline:true },
            { name:'📁 Progetti',     value:`\`${s.projects}\``,  inline:true },
            { name:'🎫 Ticket',       value:`\`${s.tickets}\``,   inline:true },
            ...(top?[{ name:'🏆 Più carico', value:`<@${top.assigned_to}>  ·  \`${top.cnt} task\``, inline:false }]:[])
          )
          .setFooter({ text:'E.C.H.O. Smart Dispatcher v3.1' }).setTimestamp()
        ]
      });
    }

    if (sub === 'digest') {
      await sendDailyDigest(guild, interaction);
    }
  }
});

// ══════════════════════════════════════════════════════════════
//  DIGEST
// ══════════════════════════════════════════════════════════════
async function sendDailyDigest(guild, interaction = null) {
  const now_   = now();
  const open   = db.prepare("SELECT * FROM tasks WHERE status='open' ORDER BY created_at ASC LIMIT 10").all();
  const blocked= db.prepare("SELECT * FROM tasks WHERE status='blocked'").all();
  const overdue= db.prepare(`SELECT * FROM tasks WHERE due_date < ${now_} AND status NOT IN ('completed','cancelled')`).all();
  const crit   = db.prepare("SELECT * FROM tasks WHERE priority IN ('critical','high') AND status NOT IN ('completed','cancelled') ORDER BY created_at ASC LIMIT 5").all();
  const tkts   = db.prepare("SELECT * FROM tickets WHERE status='open' ORDER BY created_at ASC LIMIT 5").all();
  const total  = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
  const done   = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='completed'").get().c;

  const embed  = new EmbedBuilder()
    .setColor(COLOR.cyan)
    .setTitle('📅  E.C.H.O. — Digest Giornaliero')
    .setDescription(`\`${bar(done,total)}\`  ·  ${done}/${total} task completati`)
    .setTimestamp();

  if (overdue.length) embed.addFields({ name:`⚠️ Scaduti (${overdue.length})`,        value:overdue.map(t=>`\`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (blocked.length) embed.addFields({ name:`🔴 Bloccati (${blocked.length})`,       value:blocked.map(t=>`\`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (crit.length)    embed.addFields({ name:`🔥 Alta priorità (${crit.length})`,     value:crit.map(t=>`${P_EMOJI[t.priority]} \`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (open.length)    embed.addFields({ name:`🔵 Aperti (${open.length})`,            value:open.map(t=>`\`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (tkts.length)    embed.addFields({ name:`🎫 Ticket in attesa (${tkts.length})`,  value:tkts.map(t=>`\`${t.code}\` ${t.tg_name||t.tg_username||'N/A'}`).join('\n').slice(0,1024) });
  if (!embed.data.fields?.length) embed.setDescription(`\`${bar(done,total)}\`\n\n🎉 Tutto in ordine — Team in forma!`);
  embed.setFooter({ text:'E.C.H.O. v3.1  ·  Digest automatico' });

  if (interaction) return interaction.reply({ embeds:[embed] });
  if (CH_LOG) guild.channels.fetch(CH_LOG).then(ch=>ch?.send({ embeds:[embed] }).catch(()=>{})).catch(()=>{});
}

// ══════════════════════════════════════════════════════════════
//  CRON JOBS
// ══════════════════════════════════════════════════════════════
function startCronJobs(guild) {
  // Ogni minuto — reminder scadenze
  cron.schedule('* * * * *', () => {
    const due = stmt.dueReminders.all(now());
    for (const r of due) {
      const task = stmt.getTask.get(r.task_code);
      if (!task) continue;
      const target = task.thread_id || CH_LOG;
      if (!target) continue;
      guild.channels.fetch(target).then(ch => {
        if (!ch) return;
        const mention = task.assigned_to ? `<@${task.assigned_to}>` : (ROLE_OPS ? `<@&${ROLE_OPS}>` : '');
        ch.send({
          content: mention || undefined,
          embeds: [new EmbedBuilder()
            .setColor(COLOR.amber)
            .setTitle('⏰  Reminder Scadenza')
            .setDescription(`Task **${task.code}** — ${task.title}\nScade ${ts(task.due_date)}  ·  ${tsF(task.due_date)}`)
            .setFooter({ text:`E.C.H.O.  ·  ${task.code}` })
          ],
          allowedMentions: {
            users:  task.assigned_to ? [task.assigned_to] : [],
            roles:  ROLE_OPS && !task.assigned_to ? [ROLE_OPS] : []
          }
        }).catch(() => {});
      }).catch(() => {});
      stmt.sentReminder.run(r.id);
    }
  });

  // Ogni 30 min — escalation critici non assegnati
  cron.schedule('*/30 * * * *', () => {
    const tasks = db.prepare(`SELECT * FROM tasks WHERE priority IN ('critical','high') AND assigned_to IS NULL AND status='open' AND created_at < ?`).all(now() - 7200);
    if (!tasks.length || !CH_LOG) return;
    guild.channels.fetch(CH_LOG).then(ch => {
      if (!ch) return;
      for (const t of tasks) {
        ch.send({
          content: ROLE_EXECUTIVE ? `<@&${ROLE_EXECUTIVE}>` : undefined,
          embeds: [new EmbedBuilder()
            .setColor(COLOR.red)
            .setTitle('🚨  Escalation')
            .setDescription(`Task ${P_EMOJI[t.priority]} **${t.code}** non assegnato da 2+ ore.\n\n**${t.title}**`)
            .setFooter({ text:`E.C.H.O.  ·  ${t.code}` }).setTimestamp()
          ],
          allowedMentions: { roles: ROLE_EXECUTIVE ? [ROLE_EXECUTIVE] : [] }
        }).catch(() => {});
      }
    }).catch(() => {});
  });

  // Ogni giorno alle 09:00
  cron.schedule('0 9 * * *', () => sendDailyDigest(guild));
  console.log('[E.C.H.O.] Cron jobs avviati.');
}

// ══════════════════════════════════════════════════════════════
//  HTTP SERVER — Health check + GitHub Webhook
// ══════════════════════════════════════════════════════════════
function startWebhookServer() {
  const server = http.createServer(async (req, res) => {
    // Health check Railway — risponde a GET /health e GET /
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type':'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        bot:    client.user?.tag || 'starting',
        uptime: client.uptime || 0,
        tg:     !!tgBot
      }));
    }

    if (req.method !== 'POST' || req.url !== '/webhooks/github') {
      res.writeHead(404); return res.end('Not found');
    }

    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      if (GH_SECRET) {
        const sig      = req.headers['x-hub-signature-256'];
        const expected = 'sha256=' + crypto.createHmac('sha256', GH_SECRET).update(body).digest('hex');
        if (sig !== expected) { res.writeHead(401); return res.end('Unauthorized'); }
      }

      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }

      const event = req.headers['x-github-event'];
      const guild = client.guilds.cache.get(GUILD_ID);
      if (!guild) { res.writeHead(500); return res.end(); }

      if (event === 'push' && payload.commits) {
        for (const commit of payload.commits) {
          const fixes = [...commit.message.matchAll(/(?:fix|close[sd]?|resolve[sd]?)\s+(T-\d+)/gi)];
          for (const [, code] of fixes) {
            const task = stmt.getTask.get(code.toUpperCase());
            if (task) updateTaskStatus(guild, task.code, 'completed', 'github');
          }
          if (CH_LOG) {
            guild.channels.fetch(CH_LOG).then(ch => ch?.send({
              embeds:[new EmbedBuilder()
                .setColor(COLOR.grey)
                .setDescription(`📦 **GitHub Push**  ·  \`${payload.repository?.full_name}\`\n\`${commit.id.slice(0,7)}\`  ${commit.message.split('\n')[0].slice(0,100)}  ·  **${commit.author?.name}**`)
              ]
            }).catch(()=>{})).catch(()=>{});
          }
        }
      }

      if (event === 'issues' && payload.action === 'opened') {
        createTask(guild, CH_BUG_TRACKER||CH_TASK_BOARD, `[GitHub] ${payload.issue.title}`, payload.issue.body?.slice(0,500)||'', 'github', { category:'bug', priority:'high' });
      }

      res.writeHead(200); res.end('OK');
    });
  });

  server.on('error', err => console.error('[E.C.H.O.] HTTP server error:', err.message));
  server.listen(WEBHOOK_PORT, () => console.log(`[E.C.H.O.] HTTP server su porta ${WEBHOOK_PORT}`));
}

// ══════════════════════════════════════════════════════════════
//  PROTEZIONE CRASH GLOBALE
// ══════════════════════════════════════════════════════════════
process.on('unhandledRejection', err => console.error('[E.C.H.O.] Unhandled Rejection:', err?.message || err));
process.on('uncaughtException',  err => console.error('[E.C.H.O.] Uncaught Exception:',  err?.message || err));

// ══════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════
client.login(TOKEN);
