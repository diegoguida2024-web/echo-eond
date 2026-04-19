// ╔══════════════════════════════════════════════════════════════╗
// ║        E.C.H.O. — Smart Dispatcher v3.0 FINAL               ║
// ║        Discord + Telegram | SQLite | Projects | Tickets      ║
// ║        Railway-ready | Crash-proof | Premium UI              ║
// ╚══════════════════════════════════════════════════════════════╝

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

// ══════════════════════════════════════════════════════════════
//  ENV
// ══════════════════════════════════════════════════════════════
const TOKEN           = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.DISCORD_CLIENT_ID;
const GUILD_ID        = process.env.DISCORD_GUILD_ID;
const CH_TASK_BOARD   = process.env.CHANNEL_TASK_BOARD;
const CH_BUG_TRACKER  = process.env.CHANNEL_BUG_TRACKER;
const CH_DEV_REQUESTS = process.env.CHANNEL_DEV_REQUESTS;
const CH_LOG          = process.env.CHANNEL_LOG;
const CH_TICKETS      = process.env.CHANNEL_TICKETS;
const ROLE_EXECUTIVE  = process.env.ROLE_EXECUTIVE;
const ROLE_OPS        = process.env.ROLE_OPS;
const TG_TOKEN        = process.env.TELEGRAM_TOKEN;
const TG_LOG_CHAT     = process.env.TELEGRAM_LOG_CHAT   || null;
const GH_SECRET       = process.env.GITHUB_WEBHOOK_SECRET || null;
const WEBHOOK_PORT    = parseInt(process.env.WEBHOOK_PORT) || 3001;
// Railway: aggiungi variabile DB_PATH=/data/dispatcher.db
// e monta un Volume Railway in /data per persistenza tra deploy
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'dispatcher.db');

// ══════════════════════════════════════════════════════════════
//  DATABASE
// ══════════════════════════════════════════════════════════════
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

  CREATE TABLE IF NOT EXISTS task_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    val INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS project_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    val INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ticket_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    val INTEGER DEFAULT 0
  );

  INSERT OR IGNORE INTO task_counter    VALUES (1, 0);
  INSERT OR IGNORE INTO project_counter VALUES (1, 0);
  INSERT OR IGNORE INTO ticket_counter  VALUES (1, 0);

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
`);

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
function nextTaskCode()    { db.prepare('UPDATE task_counter    SET val=val+1 WHERE id=1').run(); return `T-${String(db.prepare('SELECT val FROM task_counter    WHERE id=1').get().val).padStart(3,'0')}`; }
function nextProjectCode() { db.prepare('UPDATE project_counter SET val=val+1 WHERE id=1').run(); return `P-${String(db.prepare('SELECT val FROM project_counter WHERE id=1').get().val).padStart(3,'0')}`; }
function nextTicketCode()  { db.prepare('UPDATE ticket_counter  SET val=val+1 WHERE id=1').run(); return `TKT-${String(db.prepare('SELECT val FROM ticket_counter  WHERE id=1').get().val).padStart(3,'0')}`; }

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

function progressBar(done, total, len = 10) {
  if (total === 0) return '░'.repeat(len) + ' 0%';
  const filled = Math.round((done / total) * len);
  const pct    = Math.round((done / total) * 100);
  return '█'.repeat(filled) + '░'.repeat(len - filled) + ` ${pct}%`;
}

// ══════════════════════════════════════════════════════════════
//  CONSTANTS — UI
// ══════════════════════════════════════════════════════════════
const COLOR = {
  gold    : 0xD4AF37,
  blue    : 0x2F80ED,
  cyan    : 0x00A3FF,
  green   : 0x27AE60,
  orange  : 0xFF6B35,
  red     : 0xFF0000,
  amber   : 0xF39C12,
  purple  : 0x8E44AD,
  grey    : 0x2C2F33,
  critical: 0xFF0000,
  high    : 0xFF6B35,
  medium  : 0xF39C12,
  low     : 0x27AE60,
};

const PRIORITY_EMOJI = { critical: '🚨', high: '🔥', medium: '❗', low: '⏳' };
const STATUS_EMOJI   = { open: '🔵', in_progress: '🟡', blocked: '🔴', completed: '✅', cancelled: '🚫', reviewing: '🔍' };
const STATUS_LABEL   = { open: 'Open', in_progress: 'In Progress', blocked: 'Bloccato', completed: 'Completato', cancelled: 'Annullato', reviewing: 'In Review' };
const CATEGORY_EMOJI = { bug: '🐛', feature: '✨', task: '📋', request: '📨', urgent: '⚡', docs: '📝' };

const SERVICES = [
  { id: 'discord_setup',    label: 'Setup Server Discord',       emoji: '🖥️',  price: '30–80€'       },
  { id: 'bot_commission',   label: 'Bot Discord su commissione', emoji: '🤖',  price: '50–150€'      },
  { id: 'dispatcher',       label: 'Installazione Dispatcher',   emoji: '⚙️',  price: '40–100€'      },
  { id: 'discord_template', label: 'Template Discord',           emoji: '📦',  price: '5–15€'        },
  { id: 'consulting',       label: 'Consulenza tecnica',         emoji: '💬',  price: '20–50€/h'     },
  { id: 'other',            label: 'Personalizzato',             emoji: '✏️',  price: 'Da concordare' },
];

// ══════════════════════════════════════════════════════════════
//  ANALYSIS ENGINE
// ══════════════════════════════════════════════════════════════
function analyzePriority(text) {
  const t = text.toLowerCase();
  if (['critico','critical','hotfix','emergenza','production down','impossibile usare','down'].some(k => t.includes(k))) return 'critical';
  if (['urgente','urgent','bug','crash','broken','non funziona','bloccato','asap','entro oggi','errore','error','fix'].some(k => t.includes(k))) return 'high';
  if (['migliora','miglioramento','improve','idea','quando puoi','opzionale','optional','low'].some(k => t.includes(k))) return 'low';
  return 'medium';
}

function analyzeCategory(text) {
  const t = text.toLowerCase();
  if (t.includes('bug') || t.includes('fix') || t.includes('crash') || t.includes('errore')) return 'bug';
  if (t.includes('feature') || t.includes('aggiungi') || t.includes('implement') || t.includes('nuovo')) return 'feature';
  if (t.includes('richiesta') || t.includes('request') || t.includes('cliente')) return 'request';
  if (t.includes('urgente') || t.includes('critico') || t.includes('asap')) return 'urgent';
  if (t.includes('doc') || t.includes('readme') || t.includes('guida')) return 'docs';
  return 'task';
}

function parseDeadline(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const d = new Date();
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
//  EMBED BUILDERS — PREMIUM UI
// ══════════════════════════════════════════════════════════════
function buildTaskEmbed(task, notes = []) {
  const project  = task.project_id ? db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id) : null;
  const pEmoji   = PRIORITY_EMOJI[task.priority]  || '❓';
  const sEmoji   = STATUS_EMOJI[task.status]       || '❓';
  const cEmoji   = CATEGORY_EMOJI[task.category]   || '📋';
  const color    = COLOR[task.priority] || COLOR.blue;
  const isOverdue = task.due_date && task.due_date < now() && !['completed','cancelled'].includes(task.status);

  const embed = new EmbedBuilder()
    .setColor(isOverdue ? COLOR.red : color)
    .setTitle(`${cEmoji}  \`${task.code}\`  —  ${task.title}`)
    .addFields(
      { name: `${sEmoji} Stato`,      value: `**${STATUS_LABEL[task.status] || task.status}**`,               inline: true },
      { name: `${pEmoji} Priorità`,   value: `**${task.priority.toUpperCase()}**`,                            inline: true },
      { name: `${cEmoji} Categoria`,  value: `**${task.category.toUpperCase()}**`,                            inline: true },
      { name: '👤 Assegnato a',       value: task.assigned_to ? `<@${task.assigned_to}>` : '_Non assegnato_', inline: true },
      { name: '🕐 Creato',            value: tsF(task.created_at),                                             inline: true },
      { name: '\u200B',               value: '\u200B',                                                         inline: true },
    );

  if (task.description && task.description.trim())
    embed.setDescription(`> ${task.description.trim().replace(/\n/g, '\n> ')}`);

  if (project)
    embed.addFields({ name: '📁 Progetto', value: `\`${project.code}\` — ${project.name}${project.client_name ? ` *(${project.client_name})*` : ''}`, inline: false });

  if (task.tags && task.tags.trim())
    embed.addFields({ name: '🏷️ Tag', value: task.tags.split(',').map(t => `\`${t.trim()}\``).join(' '), inline: false });

  if (task.due_date) {
    const overdueWarning = isOverdue ? ' ⚠️ **SCADUTO**' : '';
    embed.addFields({ name: `⏰ Scadenza${overdueWarning}`, value: `${tsF(task.due_date)}  ·  ${ts(task.due_date)}`, inline: false });
  }

  if (notes.length) {
    embed.addFields({
      name: '📝 Note recenti',
      value: notes.slice(0,3).map(n => `${fmtActor(n.author_id)} *${ts(n.created_at)}*\n${n.content}`).join('\n\n').slice(0,1020)
    });
  }

  if (task.thread_id)
    embed.addFields({ name: '🧵 Thread', value: `<#${task.thread_id}>`, inline: true });

  embed
    .setFooter({ text: `E.C.H.O. Smart Dispatcher  ·  ${task.code}  ·  aggiornato ${new Date().toLocaleTimeString('it-IT')}` })
    .setTimestamp();

  return embed;
}

function buildTaskButtons(task) {
  const closed = ['completed','cancelled'].includes(task.status);
  const inProg = task.status === 'in_progress';
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`task_take_${task.code}`).setLabel('Prendo in carico').setStyle(ButtonStyle.Primary).setEmoji('🙋').setDisabled(closed || inProg),
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
  const statusColor = { open: COLOR.cyan, accepted: COLOR.green, rejected: COLOR.red, working: COLOR.amber, delivered: COLOR.gold };
  const statusLabel = { open: '🔵 In attesa', accepted: '✅ Accettato', rejected: '❌ Rifiutato', working: '🔧 In lavorazione', delivered: '📦 Consegnato' };

  return new EmbedBuilder()
    .setColor(statusColor[ticket.status] || COLOR.grey)
    .setTitle(`🎫  Ticket \`${ticket.code}\``)
    .setDescription(
      `> ${ticket.description.slice(0, 300).replace(/\n/g, '\n> ')}`
    )
    .addFields(
      { name: '👤 Cliente',    value: `${ticket.tg_name || 'N/A'}${ticket.tg_username ? `\n@${ticket.tg_username}` : ''}`, inline: true },
      { name: `${svc?.emoji || '🛎️'} Servizio`, value: svc ? `${svc.label}` : ticket.service_type,   inline: true },
      { name: '💰 Prezzo',     value: svc?.price || 'Da concordare',                                  inline: true },
      { name: '📊 Stato',      value: statusLabel[ticket.status] || ticket.status,                     inline: true },
      { name: '📅 Ricevuto',   value: `${tsF(ticket.created_at)}\n${ts(ticket.created_at)}`,           inline: true },
      { name: '🔗 Task',       value: ticket.task_code ? `\`${ticket.task_code}\`` : '_Non creato_',   inline: true },
    )
    .setFooter({ text: `E.C.H.O. Shop  ·  ${ticket.code}` })
    .setTimestamp();
}

function buildTicketButtons(ticket) {
  const open    = ticket.status === 'open';
  const working = ticket.status === 'accepted' || ticket.status === 'working';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tkt_accept_${ticket.code}`).setLabel('Accetta').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(!open),
    new ButtonBuilder().setCustomId(`tkt_reject_${ticket.code}`).setLabel('Rifiuta').setStyle(ButtonStyle.Danger).setEmoji('❌').setDisabled(!open),
    new ButtonBuilder().setCustomId(`tkt_working_${ticket.code}`).setLabel('In Lavorazione').setStyle(ButtonStyle.Primary).setEmoji('🔧').setDisabled(!working && !open),
    new ButtonBuilder().setCustomId(`tkt_done_${ticket.code}`).setLabel('Consegnato').setStyle(ButtonStyle.Secondary).setEmoji('📦').setDisabled(ticket.status === 'delivered' || ticket.status === 'rejected')
  )];
}

function buildProjectEmbed(project) {
  const tasks     = db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC').all(project.id);
  const total     = tasks.length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const blocked   = tasks.filter(t => t.status === 'blocked').length;
  const open      = tasks.filter(t => t.status === 'open').length;
  const inprog    = tasks.filter(t => t.status === 'in_progress').length;

  const statusColors = { active: COLOR.green, completed: COLOR.gold, paused: COLOR.amber, cancelled: COLOR.red };

  return new EmbedBuilder()
    .setColor(statusColors[project.status] || COLOR.grey)
    .setTitle(`📁  \`${project.code}\`  —  ${project.name}`)
    .setDescription(project.description ? `> ${project.description}` : '_Nessuna descrizione_')
    .addFields(
      { name: '👤 Cliente',      value: project.client_name || '_N/A_',                                         inline: true },
      { name: '📊 Stato',        value: project.status.toUpperCase(),                                            inline: true },
      { name: '📅 Creato',       value: tsD(project.created_at),                                                 inline: true },
      { name: '📈 Avanzamento',  value: `\`${progressBar(completed, total)}\`\n${completed}/${total} completati`, inline: false },
      { name: '🔵 Aperti',       value: `${open}`,    inline: true },
      { name: '🟡 In Progress',  value: `${inprog}`,  inline: true },
      { name: '🔴 Bloccati',     value: `${blocked}`, inline: true },
    )
    .setFooter({ text: `E.C.H.O. Projects  ·  ${project.code}` })
    .setTimestamp();
}

// ══════════════════════════════════════════════════════════════
//  CORE FUNCTIONS
// ══════════════════════════════════════════════════════════════
async function createTask(guild, channelId, title, description, createdBy, opts = {}) {
  const code      = nextTaskCode();
  const priority  = opts.priority || analyzePriority(`${title} ${description}`);
  const category  = opts.category || analyzeCategory(`${title} ${description}`);
  const due_date  = opts.due_date !== undefined ? opts.due_date : parseDeadline(`${title} ${description}`);
  const projectId = opts.project_id || null;
  const tags      = opts.tags || '';
  const t         = now();

  db.prepare(`
    INSERT INTO tasks (code,project_id,title,description,priority,category,status,created_by,channel_id,due_date,tags,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(code, projectId, title, description, priority, category, 'open', createdBy, channelId, due_date, tags, t, t);

  const task    = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return task;

  const msg = await channel.send({ embeds: [buildTaskEmbed(task)], components: buildTaskButtons(task) });

  let thread = null;
  try {
    thread = await msg.startThread({
      name: `${code} — ${title.slice(0, 90)}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek
    });
    await thread.send({
      embeds: [new EmbedBuilder()
        .setColor(COLOR[priority] || COLOR.blue)
        .setTitle(`🧵  Thread di lavoro — ${code}`)
        .setDescription(
          `**${title}**\n\n` +
          `Usa questo thread per aggiornamenti, note e discussioni relative a questo task.\n\n` +
          `> Creato da ${fmtActor(createdBy)}  ·  ${tsF(t)}`
        )
        .addFields(
          { name: `${PRIORITY_EMOJI[priority]} Priorità`, value: priority.toUpperCase(), inline: true },
          { name: `${CATEGORY_EMOJI[category]} Tipo`,     value: category.toUpperCase(), inline: true },
        )
        .setFooter({ text: `E.C.H.O. Smart Dispatcher  ·  ${code}` })
      ]
    });
  } catch (_) {}

  db.prepare('UPDATE tasks SET thread_id=?, message_id=?, updated_at=? WHERE code=?')
    .run(thread?.id || null, msg.id, now(), code);

  if (due_date) {
    const remindAt = due_date - 3600;
    if (remindAt > now()) db.prepare('INSERT INTO reminders (task_code,remind_at) VALUES (?,?)').run(code, remindAt);
  }

  await logEvent(guild, `📋 Task **${code}** creato da ${fmtActor(createdBy)}  ·  ${PRIORITY_EMOJI[priority]} ${priority.toUpperCase()}  ·  ${title}`);
  return task;
}

async function updateTaskStatus(guild, code, newStatus, actorId) {
  const task = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
  if (!task) return null;

  db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE code=?').run(newStatus, now(), code);
  const updated = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);

  const channel = await guild.channels.fetch(task.channel_id).catch(() => null);
  if (channel && task.message_id) {
    const msg = await channel.messages.fetch(task.message_id).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildTaskEmbed(updated)], components: buildTaskButtons(updated) }).catch(() => {});
  }

  if (task.thread_id) {
    const thread = await guild.channels.fetch(task.thread_id).catch(() => null);
    if (thread) {
      await thread.send({
        embeds: [new EmbedBuilder()
          .setColor(COLOR[newStatus.replace('_','')] || (newStatus === 'completed' ? COLOR.green : COLOR.blue))
          .setDescription(`${STATUS_EMOJI[newStatus]}  Stato aggiornato → **${STATUS_LABEL[newStatus] || newStatus}**\nda ${fmtActor(actorId)}  ·  ${ts(now())}`)
        ]
      }).catch(() => {});
    }
  }

  await logEvent(guild, `${STATUS_EMOJI[newStatus]} Task **${code}** → **${(STATUS_LABEL[newStatus] || newStatus).toUpperCase()}**  da ${fmtActor(actorId)}`);
  return updated;
}

async function assignTask(guild, code, userId, actorId) {
  const task = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
  if (!task) return null;

  db.prepare('UPDATE tasks SET assigned_to=?, status=?, updated_at=? WHERE code=?')
    .run(userId, 'in_progress', now(), code);
  const updated = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);

  const channel = await guild.channels.fetch(task.channel_id).catch(() => null);
  if (channel && task.message_id) {
    const msg = await channel.messages.fetch(task.message_id).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildTaskEmbed(updated)], components: buildTaskButtons(updated) }).catch(() => {});
  }

  if (task.thread_id) {
    const thread = await guild.channels.fetch(task.thread_id).catch(() => null);
    if (thread) {
      await thread.send({
        embeds: [new EmbedBuilder()
          .setColor(COLOR.cyan)
          .setDescription(`👤  Task assegnato a <@${userId}>\nda ${fmtActor(actorId)}  ·  ${ts(now())}`)
        ]
      }).catch(() => {});
    }
  }

  await logEvent(guild, `👤 Task **${code}** assegnato a <@${userId}>  da ${fmtActor(actorId)}`);
  return updated;
}

async function logEvent(guild, message) {
  if (!CH_LOG) return;
  const ch = await guild.channels.fetch(CH_LOG).catch(() => null);
  if (ch) await ch.send(`\`${new Date().toISOString().slice(0,19)}\`  ${message}`).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
//  TICKET SYSTEM
// ══════════════════════════════════════════════════════════════
async function createTicketFromTelegram(guild, tgUser, serviceId, description) {
  const code = nextTicketCode();
  const t    = now();

  db.prepare(`
    INSERT INTO tickets (code,tg_user_id,tg_username,tg_name,service_type,description,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(code, String(tgUser.id), tgUser.username || null, tgUser.first_name || null, serviceId, description, t, t);

  const ticket   = db.prepare('SELECT * FROM tickets WHERE code=?').get(code);
  const targetCh = CH_TICKETS || CH_TASK_BOARD;
  const channel  = await guild.channels.fetch(targetCh).catch(() => null);

  if (channel) {
    const mention = ROLE_OPS ? `<@&${ROLE_OPS}>` : '';
    const msg = await channel.send({
      content: mention ? `${mention}  🎫 Nuova richiesta da Telegram!` : '🎫 Nuova richiesta da Telegram!',
      embeds: [buildTicketEmbed(ticket)],
      components: buildTicketButtons(ticket),
      allowedMentions: { roles: ROLE_OPS ? [ROLE_OPS] : [] }
    });
    db.prepare('UPDATE tickets SET discord_msg=?, updated_at=? WHERE code=?').run(msg.id, now(), code);

    const svc  = SERVICES.find(s => s.id === serviceId);
    const task = await createTask(
      guild, CH_TASK_BOARD || targetCh,
      `[TKT] ${svc?.emoji || ''} ${svc?.label || serviceId} — ${tgUser.first_name || tgUser.username || 'Cliente'}`,
      description, 'telegram',
      { category: 'request', priority: 'high', tags: `ticket:${code}` }
    );
    db.prepare('UPDATE tickets SET task_code=?, updated_at=? WHERE code=?').run(task.code, now(), code);
  }

  await logEvent(guild, `🎫 Nuovo ticket **${code}**  Telegram  ·  Servizio: ${serviceId}  ·  ${tgUser.first_name || tgUser.username || 'N/A'}`);
  return ticket;
}

async function updateTicketStatus(guild, ticketCode, newStatus, actorId) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE code=?').get(ticketCode);
  if (!ticket) return null;

  db.prepare('UPDATE tickets SET status=?, updated_at=? WHERE code=?').run(newStatus, now(), ticketCode);
  const updated = db.prepare('SELECT * FROM tickets WHERE code=?').get(ticketCode);

  const tgMessages = {
    accepted : '✅ La tua richiesta è stata *accettata*\\! Ti contatteremo a breve per discutere i dettagli\\.',
    rejected : '❌ La tua richiesta non può essere gestita al momento\\. Scrivici per ulteriori informazioni\\.',
    working  : '🔧 Il tuo progetto è ora *in lavorazione*\\! Ti terremo aggiornato sullo stato di avanzamento\\.',
    delivered: '📦 Il tuo progetto è stato *completato e consegnato*\\! Grazie per aver scelto *E\\.C\\.H\\.O\\. Studio*\\.'
  };

  if (tgMessages[newStatus] && tgBot) {
    tgBot.sendMessage(ticket.tg_user_id, tgMessages[newStatus], { parse_mode: 'MarkdownV2' }).catch(() => {});
  }

  await logEvent(guild, `🎫 Ticket **${ticketCode}** → **${newStatus.toUpperCase()}**  da ${fmtActor(actorId)}`);
  return updated;
}

// ══════════════════════════════════════════════════════════════
//  TELEGRAM BOT
// ══════════════════════════════════════════════════════════════
let tgBot = null;
const tgSessions = {};

// Escape MarkdownV2
const esc = s => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

function initTelegram(guild) {
  if (!TG_TOKEN) {
    console.log('[E.C.H.O.] TELEGRAM_TOKEN non impostato — Telegram disabilitato.');
    return;
  }

  tgBot = new TelegramBot(TG_TOKEN, { polling: true });
  console.log('[E.C.H.O.] Bot Telegram avviato.');

  tgBot.on('polling_error', err => console.error('[E.C.H.O.] Telegram polling error:', err.code || err.message));

  // ── /start ──
  tgBot.onText(/\/start/, msg => {
    const name = esc(msg.from.first_name || 'amico');
    tgBot.sendMessage(msg.chat.id, [
      `👋 Benvenuto in *E\\.C\\.H\\.O\\. Studio*, ${name}\\!`,
      '',
      '⚙️ Siamo specializzati in:',
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
    ].join('\n'), { parse_mode: 'MarkdownV2' });
  });

  // ── /help ──
  tgBot.onText(/\/help/, msg => {
    tgBot.sendMessage(msg.chat.id, [
      '📖 *Guida E\\.C\\.H\\.O\\. Studio*',
      '',
      '`/start` — Messaggio di benvenuto',
      '`/servizi` — Catalogo servizi con prezzi',
      '`/richiedi` — Apri una nuova richiesta',
      '`/stato` — Controlla i tuoi ticket aperti',
      '`/help` — Questa guida',
      '',
      '_Per qualsiasi domanda puoi scrivere liberamente\\!_',
    ].join('\n'), { parse_mode: 'MarkdownV2' });
  });

  // ── /chatid ──
  tgBot.onText(/\/chatid/, msg => {
    tgBot.sendMessage(msg.chat.id, `🆔 Chat ID: \`${msg.chat.id}\``, { parse_mode: 'MarkdownV2' });
  });

  // ── /servizi ──
  tgBot.onText(/\/servizi/, msg => {
    const lines = [
      '🛎️ *Servizi E\\.C\\.H\\.O\\. Studio*',
      '━━━━━━━━━━━━━━━━━━━━',
      ''
    ];
    for (const s of SERVICES) {
      lines.push(`${esc(s.emoji)} *${esc(s.label)}*`);
      lines.push(`💰 Prezzo: \`${esc(s.price)}\``);
      lines.push('');
    }
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('_Usa /richiedi per iniziare_');
    tgBot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'MarkdownV2' });
  });

  // ── /richiedi ──
  tgBot.onText(/\/richiedi/, msg => {
    const chatId = msg.chat.id;
    tgSessions[chatId] = { step: 'select_service' };
    tgBot.sendMessage(chatId, '🎫 *Nuova Richiesta*\n\nSeleziona il servizio che ti interessa:', {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: SERVICES.map(s => ([{
          text: `${s.emoji} ${s.label}  —  ${s.price}`,
          callback_data: `svc_${s.id}`
        }]))
      }
    });
  });

  // ── /stato ──
  tgBot.onText(/\/stato/, msg => {
    const chatId  = msg.chat.id;
    const tickets = db.prepare('SELECT * FROM tickets WHERE tg_user_id=? ORDER BY created_at DESC LIMIT 5').all(String(chatId));
    if (!tickets.length) {
      return tgBot.sendMessage(chatId, '📭 Nessun ticket trovato\\.\n\nUsa /richiedi per aprirne uno\\.', { parse_mode: 'MarkdownV2' });
    }
    const statusIcon = { open: '🔵', accepted: '✅', rejected: '❌', working: '🔧', delivered: '📦' };
    const lines = ['📦 *I tuoi ticket:*', ''];
    for (const t of tickets) {
      const svc = SERVICES.find(s => s.id === t.service_type);
      lines.push(`${statusIcon[t.status] || '❓'} \`${esc(t.code)}\``);
      lines.push(`   ${esc(svc?.emoji || '')} ${esc(svc?.label || t.service_type)}`);
      lines.push(`   Stato: *${esc(t.status.toUpperCase())}*`);
      lines.push('');
    }
    tgBot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
  });

  // ── Callback query ──
  tgBot.on('callback_query', async query => {
    const chatId  = query.message.chat.id;
    const session = tgSessions[chatId];
    tgBot.answerCallbackQuery(query.id).catch(() => {});

    if (query.data.startsWith('svc_') && session?.step === 'select_service') {
      const serviceId = query.data.replace('svc_', '');
      const svc       = SERVICES.find(s => s.id === serviceId);
      if (!svc) return;
      tgSessions[chatId] = { step: 'write_description', serviceId };
      tgBot.sendMessage(chatId, [
        `${esc(svc.emoji)} *Servizio selezionato: ${esc(svc.label)}*`,
        `💰 Prezzo indicativo: \`${esc(svc.price)}\``,
        '',
        '📝 *Descrivi la tua richiesta:*',
        '_Includi tutti i dettagli utili: cosa ti serve, preferenze, eventuali scadenze\\._',
      ].join('\n'), { parse_mode: 'MarkdownV2' });
    }
  });

  // ── Messaggi liberi ──
  tgBot.on('message', async msg => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId  = msg.chat.id;
    const session = tgSessions[chatId];

    if (session?.step === 'write_description') {
      delete tgSessions[chatId];
      tgBot.sendMessage(chatId, '⏳ Richiesta in invio al team\\.\\.\\.', { parse_mode: 'MarkdownV2' });

      if (guild) {
        const ticket = await createTicketFromTelegram(guild, msg.from, session.serviceId, msg.text);
        tgBot.sendMessage(chatId, [
          '🎫 *Richiesta inviata con successo\\!*',
          '',
          `📋 Codice ticket: \`${esc(ticket.code)}\``,
          '',
          'Il team analizzerà la tua richiesta e ti risponderà al più presto\\.',
          'Usa /stato per monitorare l\'avanzamento\\.',
        ].join('\n'), { parse_mode: 'MarkdownV2' });

        if (TG_LOG_CHAT) {
          const svc = SERVICES.find(s => s.id === session.serviceId);
          tgBot.sendMessage(TG_LOG_CHAT, [
            `🎫 *Nuovo ticket* \`${ticket.code}\``,
            `👤 ${esc(msg.from.first_name || '')}${msg.from.username ? ` \\(@${esc(msg.from.username)}\\)` : ''}`,
            `${esc(svc?.emoji || '')} ${esc(svc?.label || session.serviceId)}`,
            `📝 ${esc(msg.text.slice(0, 200))}`,
          ].join('\n'), { parse_mode: 'MarkdownV2' }).catch(() => {});
        }
      } else {
        tgBot.sendMessage(chatId, '⚠️ Sistema temporaneamente non disponibile\\. Riprova tra qualche minuto\\.', { parse_mode: 'MarkdownV2' });
      }
      return;
    }

    // Risposta automatica generica
    tgBot.sendMessage(chatId, [
      '👋 Ciao\\! Sono il bot di *E\\.C\\.H\\.O\\. Studio*\\.',
      '',
      'Per parlare con il team:',
      '📋 /servizi — Vedi cosa offriamo',
      '🎫 /richiedi — Apri una richiesta',
      '📦 /stato — Controlla i tuoi ticket',
    ].join('\n'), { parse_mode: 'MarkdownV2' });
  });
}

// ══════════════════════════════════════════════════════════════
//  SLASH COMMANDS DEFINITION
// ══════════════════════════════════════════════════════════════
const commands = [
  new SlashCommandBuilder()
    .setName('task').setDescription('Gestione task E.C.H.O.')
    .addSubcommand(s => s.setName('create').setDescription('Crea un nuovo task')
      .addStringOption(o => o.setName('titolo').setDescription('Titolo del task').setRequired(true))
      .addStringOption(o => o.setName('descrizione').setDescription('Descrizione dettagliata'))
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
      .addStringOption(o => o.setName('progetto').setDescription('Codice progetto (es: P-001)'))
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
      .addStringOption(o => o.setName('codice').setDescription('Codice task (T-001)').setRequired(true))
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
    .addSubcommand(s => s.setName('search').setDescription('Cerca task per parola chiave')
      .addStringOption(o => o.setName('query').setDescription('Parola chiave').setRequired(true))
    )
    .addSubcommand(s => s.setName('stats').setDescription('Statistiche complete'))
    .addSubcommand(s => s.setName('digest').setDescription('Digest manuale')),

  new SlashCommandBuilder()
    .setName('project').setDescription('Gestione progetti E.C.H.O.')
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

  new SlashCommandBuilder()
    .setName('ticket').setDescription('Gestione ticket clienti')
    .addSubcommand(s => s.setName('list').setDescription('Lista ticket'))
    .addSubcommand(s => s.setName('info').setDescription('Dettagli ticket')
      .addStringOption(o => o.setName('codice').setDescription('Codice ticket').setRequired(true))
    )
    .addSubcommand(s => s.setName('create').setDescription('Crea ticket manuale')
      .addStringOption(o => o.setName('servizio').setDescription('Tipo servizio').setRequired(true).addChoices(
        ...SERVICES.map(s => ({ name: `${s.emoji} ${s.label}`, value: s.id }))
      ))
      .addStringOption(o => o.setName('descrizione').setDescription('Descrizione').setRequired(true))
      .addStringOption(o => o.setName('cliente').setDescription('Nome cliente'))
    ),

  new SlashCommandBuilder()
    .setName('echo').setDescription('Info sistema E.C.H.O.')
    .addSubcommand(s => s.setName('status').setDescription('Stato completo del sistema'))
    .addSubcommand(s => s.setName('help').setDescription('Guida comandi'))
    .addSubcommand(s => s.setName('ping').setDescription('Test latenza'))
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
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

client.on('error', err => console.error('[E.C.H.O.] Discord client error:', err.message));

// FIX: 'ready' — unico evento corretto in discord.js v14
client.once('ready', async () => {
  console.log(`[E.C.H.O.] Discord online: ${client.user.tag}`);
  console.log(`[E.C.H.O.] DB: ${DB_PATH}`);
  client.user.setActivity('⚙️ E.O.N.D. Core  ·  /task', { type: 4 });
  await registerCommands();
  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    initTelegram(guild);
    startCronJobs(guild);
  }
  startWebhookServer();
});

// ── Auto-task dai canali monitorati ─────────────────────────
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
  const task = db.prepare('SELECT * FROM tasks WHERE message_id=?').get(reaction.message.id);
  if (!task) return;
  const map = { '✅': 'completed', '🔴': 'blocked', '🚫': 'cancelled', '🔍': 'reviewing' };
  const ns  = map[reaction.emoji.name];
  if (ns) await updateTaskStatus(reaction.message.guild, task.code, ns, user.id);
});

// ══════════════════════════════════════════════════════════════
//  INTERACTION HANDLER
// ══════════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
  const guild = interaction.guild;

  // ── BOTTONI ──────────────────────────────────────────────
  if (interaction.isButton()) {
    // FIX 10062: deferReply IMMEDIATAMENTE — prima di qualsiasi await
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);

    const parts     = interaction.customId.split('_');
    const namespace = parts[0]; // 'task' | 'tkt'
    const action    = parts[1];
    const code      = parts.slice(2).join('_');

    // ── Bottoni ticket ──
    if (namespace === 'tkt') {
      const ticket = db.prepare('SELECT * FROM tickets WHERE code=?').get(code);
      if (!ticket) return interaction.editReply({ content: '❌ Ticket non trovato.' });

      const statusMap = { accept: 'accepted', reject: 'rejected', working: 'working', done: 'delivered' };
      const newStatus = statusMap[action];
      if (!newStatus) return interaction.editReply({ content: '❓ Azione non riconosciuta.' });

      await updateTicketStatus(guild, code, newStatus, interaction.user.id);

      const targetCh = CH_TICKETS || CH_TASK_BOARD;
      const ch = await guild.channels.fetch(targetCh).catch(() => null);
      if (ch && ticket.discord_msg) {
        const msg = await ch.messages.fetch(ticket.discord_msg).catch(() => null);
        if (msg) {
          const updated = db.prepare('SELECT * FROM tickets WHERE code=?').get(code);
          await msg.edit({ embeds: [buildTicketEmbed(updated)], components: buildTicketButtons(updated) }).catch(() => {});
        }
      }
      return interaction.editReply({ content: `✅ Ticket **${code}** → **${newStatus.toUpperCase()}**.` });
    }

    // ── Bottoni task ──
    const task = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
    if (!task) return interaction.editReply({ content: '❌ Task non trovato.' });

    if (action === 'take') {
      if (task.assigned_to === interaction.user.id)
        return interaction.editReply({ content: '⚠️ Sei già assegnato a questo task.' });
      await assignTask(guild, code, interaction.user.id, interaction.user.id);
      return interaction.editReply({ content: `✅ Hai preso in carico **${code}**.` });
    }
    if (action === 'done')   { await updateTaskStatus(guild, code, 'completed', interaction.user.id); return interaction.editReply({ content: `✅ **${code}** completato.` }); }
    if (action === 'block')  { await updateTaskStatus(guild, code, 'blocked',   interaction.user.id); return interaction.editReply({ content: `🔴 **${code}** bloccato.` }); }
    if (action === 'review') { await updateTaskStatus(guild, code, 'reviewing', interaction.user.id); return interaction.editReply({ content: `🔍 **${code}** in review.` }); }
    if (action === 'cancel') { await updateTaskStatus(guild, code, 'cancelled', interaction.user.id); return interaction.editReply({ content: `🚫 **${code}** annullato.` }); }

    if (action === 'info') {
      const t     = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
      const notes = db.prepare('SELECT * FROM task_notes WHERE task_code=? ORDER BY created_at DESC LIMIT 3').all(code);
      return interaction.editReply({ embeds: [buildTaskEmbed(t, notes)] });
    }

    return interaction.editReply({ content: '❓ Azione non riconosciuta.' });
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
        embeds: [new EmbedBuilder()
          .setColor(lat < 100 ? COLOR.green : lat < 250 ? COLOR.amber : COLOR.red)
          .setTitle('🏓  Pong!')
          .addFields(
            { name: '⚡ Latenza API', value: `\`${lat}ms\``,            inline: true },
            { name: '💓 WebSocket',  value: `\`${client.ws.ping}ms\``,  inline: true },
          )
          .setFooter({ text: 'E.C.H.O. v3.0' })
        ],
        flags: MessageFlags.Ephemeral
      });
    }

    if (sub === 'status') {
      const tasks   = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
      const open    = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='open'").get().c;
      const prog    = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='in_progress'").get().c;
      const done    = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='completed'").get().c;
      const blk     = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='blocked'").get().c;
      const projs   = db.prepare("SELECT COUNT(*) as c FROM projects WHERE status='active'").get().c;
      const tkts    = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='open'").get().c;
      const rate    = tasks > 0 ? Math.round((done/tasks)*100) : 0;
      const uptime  = Math.floor(client.uptime / 1000);
      const h = Math.floor(uptime/3600), m = Math.floor((uptime%3600)/60), s = uptime%60;

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLOR.cyan)
          .setTitle('⚙️  E.C.H.O. — System Status')
          .setDescription(`\`\`\`\nE.C.H.O. Smart Dispatcher v3.0\nE.O.N.D. Core — Online\n\`\`\``)
          .addFields(
            { name: '📋 Task',             value: `\`${tasks}\` totali`, inline: true },
            { name: '🔵 Aperti',           value: `\`${open}\``,         inline: true },
            { name: '🟡 In Progress',      value: `\`${prog}\``,         inline: true },
            { name: '🔴 Bloccati',         value: `\`${blk}\``,          inline: true },
            { name: '✅ Completati',        value: `\`${done}\``,         inline: true },
            { name: '📈 Completamento',    value: `\`${progressBar(done, tasks)}\``, inline: false },
            { name: '📁 Progetti attivi',  value: `\`${projs}\``,         inline: true },
            { name: '🎫 Ticket aperti',    value: `\`${tkts}\``,          inline: true },
            { name: '📱 Telegram',         value: TG_TOKEN ? '`✅ Online`' : '`❌ Non configurato`', inline: true },
            { name: '🤖 Uptime',           value: `\`${h}h ${m}m ${s}s\``, inline: true },
          )
          .setFooter({ text: `E.C.H.O. v3.0  ·  E.O.N.D. Core  ·  DB: ${DB_PATH}` })
          .setTimestamp()
        ]
      });
    }

    if (sub === 'help') {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [new EmbedBuilder()
          .setColor(COLOR.gold)
          .setTitle('📖  E.C.H.O. — Guida Comandi v3.0')
          .setDescription('Scrivi nei canali monitorati per creare task automaticamente, oppure usa `/task create`.')
          .addFields(
            { name: '📋 /task', value: '`create` `list` `assign` `done` `info` `note` `deadline` `priority` `search` `stats` `digest`' },
            { name: '📁 /project', value: '`create` `list` `info` `report` `close`' },
            { name: '🎫 /ticket', value: '`list` `info` `create`' },
            { name: '📱 Telegram', value: `@echo_std_bot — \`/servizi\` \`/richiedi\` \`/stato\`` },
            { name: '⚡ Reazioni rapide', value: '`✅` Completa  ·  `🔴` Blocca  ·  `🚫` Annulla  ·  `🔍` Review' },
            { name: '🔧 Sistema', value: '`/echo ping`  ·  `/echo status`  ·  `/echo help`' },
          )
          .setFooter({ text: 'E.C.H.O. Smart Dispatcher v3.0  ·  E.O.N.D. Core' })
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
      const code    = nextProjectCode();
      const t       = now();
      db.prepare('INSERT INTO projects (code,name,description,client_name,created_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(code, nome, desc, cliente, interaction.user.id, 'active', t, t);
      const project = db.prepare('SELECT * FROM projects WHERE code=?').get(code);
      await logEvent(guild, `📁 Progetto **${code}** "${nome}" creato da <@${interaction.user.id}>`);
      return interaction.reply({ embeds: [buildProjectEmbed(project)] });
    }

    if (sub === 'list') {
      const projects = db.prepare("SELECT * FROM projects WHERE status='active' ORDER BY created_at DESC").all();
      if (!projects.length) return interaction.reply({ content: '📭 Nessun progetto attivo.', flags: MessageFlags.Ephemeral });
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLOR.green)
          .setTitle('📁  Progetti Attivi')
          .setDescription(projects.map(p => {
            const count = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE project_id=?').get(p.id).c;
            const done  = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE project_id=? AND status='completed'").get(p.id).c;
            return `**\`${p.code}\`** ${p.name}${p.client_name ? `  ·  *${p.client_name}*` : ''}\n${progressBar(done, count, 8)}  ·  ${count} task`;
          }).join('\n\n'))
          .setFooter({ text: `${projects.length} progetti` })
        ]
      });
    }

    if (sub === 'info') {
      const code    = options.getString('codice').toUpperCase();
      const project = db.prepare('SELECT * FROM projects WHERE UPPER(code)=?').get(code);
      if (!project) return interaction.reply({ content: `❌ Progetto \`${code}\` non trovato.`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [buildProjectEmbed(project)] });
    }

    if (sub === 'report') {
      await interaction.deferReply();
      const code    = options.getString('codice').toUpperCase();
      const project = db.prepare('SELECT * FROM projects WHERE UPPER(code)=?').get(code);
      if (!project) return interaction.editReply({ content: `❌ Progetto \`${code}\` non trovato.` });
      const tasks     = db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at ASC').all(project.id);
      const completed = tasks.filter(t => t.status === 'completed').length;

      const embed = new EmbedBuilder()
        .setColor(COLOR.gold)
        .setTitle(`📊  Report — ${project.code}  ·  ${project.name}`)
        .setDescription(project.description ? `> ${project.description}` : '_Nessuna descrizione_')
        .addFields(
          { name: '👤 Cliente',        value: project.client_name || 'N/A',             inline: true },
          { name: '📊 Stato',          value: project.status.toUpperCase(),              inline: true },
          { name: '📅 Creato',         value: tsD(project.created_at),                  inline: true },
          { name: '📈 Avanzamento',    value: `\`${progressBar(completed, tasks.length)}\`\n${completed}/${tasks.length} task completati`, inline: false },
        );

      if (tasks.length) {
        const taskList = tasks.slice(0, 15)
          .map(t => `${STATUS_EMOJI[t.status]} \`${t.code}\` ${t.title.slice(0,50)}${t.assigned_to ? ` → <@${t.assigned_to}>` : ''}`)
          .join('\n');
        embed.addFields({ name: '📋 Task', value: taskList.slice(0, 1024) });
      }

      embed.setFooter({ text: `E.C.H.O. Projects  ·  ${project.code}` }).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'close') {
      const code    = options.getString('codice').toUpperCase();
      const project = db.prepare('SELECT * FROM projects WHERE UPPER(code)=?').get(code);
      if (!project) return interaction.reply({ content: `❌ Progetto \`${code}\` non trovato.`, flags: MessageFlags.Ephemeral });
      db.prepare('UPDATE projects SET status=?, updated_at=? WHERE UPPER(code)=?').run('completed', now(), code);
      await logEvent(guild, `📁 Progetto **${code}** chiuso da <@${interaction.user.id}>`);
      return interaction.reply({ content: `✅ Progetto **${code}** chiuso.` });
    }
  }

  // ══════════════════════════════════════════════════════════
  //  /ticket
  // ══════════════════════════════════════════════════════════
  if (commandName === 'ticket') {
    const sub = options.getSubcommand();

    if (sub === 'list') {
      const tickets = db.prepare('SELECT * FROM tickets ORDER BY created_at DESC LIMIT 15').all();
      if (!tickets.length) return interaction.reply({ content: '📭 Nessun ticket.', flags: MessageFlags.Ephemeral });
      const statusIcon = { open: '🔵', accepted: '✅', rejected: '❌', working: '🔧', delivered: '📦' };
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [new EmbedBuilder()
          .setColor(COLOR.gold)
          .setTitle('🎫  Ticket')
          .setDescription(tickets.map(t => {
            const svc = SERVICES.find(s => s.id === t.service_type);
            return `${statusIcon[t.status]||'❓'} **\`${t.code}\`**  ${svc?.emoji||''} ${svc?.label||t.service_type}  ·  ${t.tg_name || t.tg_username || 'N/A'}`;
          }).join('\n'))
          .setFooter({ text: `${tickets.length} ticket` })
        ]
      });
    }

    if (sub === 'info') {
      const code   = options.getString('codice').toUpperCase();
      const ticket = db.prepare('SELECT * FROM tickets WHERE UPPER(code)=?').get(code);
      if (!ticket) return interaction.reply({ content: `❌ Ticket \`${code}\` non trovato.`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [buildTicketEmbed(ticket)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const serviceId = options.getString('servizio');
      const desc      = options.getString('descrizione');
      const cliente   = options.getString('cliente') || interaction.user.username;
      const fakeUser  = { id: interaction.user.id, username: interaction.user.username, first_name: cliente };
      const ticket    = await createTicketFromTelegram(guild, fakeUser, serviceId, desc);
      return interaction.editReply({ content: `✅ Ticket **${ticket.code}** creato.` });
    }
  }

  // ══════════════════════════════════════════════════════════
  //  /task
  // ══════════════════════════════════════════════════════════
  if (commandName === 'task') {
    const sub = options.getSubcommand();

    if (sub === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const title    = options.getString('titolo');
      const desc     = options.getString('descrizione') || '';
      const priority = options.getString('priorita')    || undefined;
      const category = options.getString('categoria')   || undefined;
      const assegna  = options.getUser('assegna');
      const scadenza = options.getString('scadenza')    || '';
      const progCod  = options.getString('progetto')    || null;
      const tagStr   = options.getString('tag')         || '';
      const due_date = parseDeadline(scadenza);

      let projectId = null;
      if (progCod) {
        const proj = db.prepare('SELECT * FROM projects WHERE UPPER(code)=?').get(progCod.toUpperCase());
        projectId  = proj?.id || null;
      }

      const targetCh = CH_TASK_BOARD || interaction.channelId;
      const task = await createTask(guild, targetCh, title, desc, interaction.user.id, { priority, category, due_date, project_id: projectId, tags: tagStr });
      if (assegna) await assignTask(guild, task.code, assegna.id, interaction.user.id);
      return interaction.editReply({
        content: `✅ Task **${task.code}** creato` +
          (assegna ? ` · assegnato a <@${assegna.id}>` : '') +
          (projectId ? ` · progetto \`${progCod?.toUpperCase()}\`` : '') + '.'
      });
    }

    if (sub === 'list') {
      const filtro  = options.getString('filtro') || 'open';
      const utente  = options.getUser('utente');
      const progCod = options.getString('progetto');
      const conds   = [], params = [];
      if (filtro !== 'all')  { conds.push('t.status=?'); params.push(filtro); }
      if (utente)            { conds.push('t.assigned_to=?'); params.push(utente.id); }
      if (progCod) {
        const proj = db.prepare('SELECT id FROM projects WHERE UPPER(code)=?').get(progCod.toUpperCase());
        if (proj)  { conds.push('t.project_id=?'); params.push(proj.id); }
      }
      const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
      const tasks = db.prepare(
        `SELECT t.*, p.code AS proj_code FROM tasks t LEFT JOIN projects p ON t.project_id=p.id${where} ORDER BY t.created_at DESC LIMIT 20`
      ).all(...params);

      if (!tasks.length) return interaction.reply({ content: '📭 Nessun task trovato.', flags: MessageFlags.Ephemeral });

      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [new EmbedBuilder()
          .setColor(COLOR.blue)
          .setTitle(`📋  Task — ${filtro === 'all' ? 'Tutti' : (STATUS_LABEL[filtro] || filtro.toUpperCase())}`)
          .setDescription(tasks.map(t =>
            `${STATUS_EMOJI[t.status]} ${PRIORITY_EMOJI[t.priority]} **\`${t.code}\`**${t.proj_code ? ` \`[${t.proj_code}]\`` : ''} ${t.title.slice(0,50)}` +
            (t.assigned_to ? `  →  <@${t.assigned_to}>` : '') +
            (t.due_date && t.due_date < now() && !['completed','cancelled'].includes(t.status) ? '  ⚠️' :
             t.due_date && t.due_date > now() ? `  ⏰${ts(t.due_date)}` : '')
          ).join('\n'))
          .setFooter({ text: `${tasks.length} task trovati` })
        ]
      });
    }

    if (sub === 'assign') {
      const code   = options.getString('codice').toUpperCase();
      const utente = options.getUser('utente');
      const task   = await assignTask(guild, code, utente.id, interaction.user.id);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `✅ Task **${code}** assegnato a <@${utente.id}>.` });
    }

    if (sub === 'done') {
      const code = options.getString('codice').toUpperCase();
      const task = await updateTaskStatus(guild, code, 'completed', interaction.user.id);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `✅ Task **${code}** completato.` });
    }

    if (sub === 'info') {
      const code  = options.getString('codice').toUpperCase();
      const task  = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, flags: MessageFlags.Ephemeral });
      const notes = db.prepare('SELECT * FROM task_notes WHERE task_code=? ORDER BY created_at DESC LIMIT 3').all(code);
      return interaction.reply({ embeds: [buildTaskEmbed(task, notes)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'note') {
      const code  = options.getString('codice').toUpperCase();
      const testo = options.getString('testo');
      const task  = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, flags: MessageFlags.Ephemeral });
      db.prepare('INSERT INTO task_notes (task_code,author_id,content,created_at) VALUES (?,?,?,?)').run(code, interaction.user.id, testo, now());
      if (task.thread_id) {
        const thread = await guild.channels.fetch(task.thread_id).catch(() => null);
        if (thread) {
          await thread.send({
            embeds: [new EmbedBuilder()
              .setColor(COLOR.blue)
              .setDescription(`📝 **Nota** da <@${interaction.user.id}>  ·  ${ts(now())}\n> ${testo}`)
            ]
          }).catch(() => {});
        }
      }
      await logEvent(guild, `📝 Nota su **${code}** da <@${interaction.user.id}>`);
      return interaction.reply({ content: `✅ Nota aggiunta a **${code}**.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'deadline') {
      const code     = options.getString('codice').toUpperCase();
      const scadenza = options.getString('scadenza');
      const due_date = parseDeadline(scadenza);
      if (!due_date) return interaction.reply({ content: '❌ Formato non riconosciuto. Usa: "domani", "in 3 giorni", "in 5 ore".', flags: MessageFlags.Ephemeral });
      const task = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, flags: MessageFlags.Ephemeral });
      db.prepare('UPDATE tasks SET due_date=?, updated_at=? WHERE code=?').run(due_date, now(), code);
      const updated = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
      const channel = await guild.channels.fetch(task.channel_id).catch(() => null);
      if (channel && task.message_id) {
        const msg = await channel.messages.fetch(task.message_id).catch(() => null);
        if (msg) await msg.edit({ embeds: [buildTaskEmbed(updated)], components: buildTaskButtons(updated) }).catch(() => {});
      }
      db.prepare('DELETE FROM reminders WHERE task_code=?').run(code);
      const remindAt = due_date - 3600;
      if (remindAt > now()) db.prepare('INSERT INTO reminders (task_code,remind_at) VALUES (?,?)').run(code, remindAt);
      return interaction.reply({ content: `⏰ Scadenza di **${code}** → ${tsF(due_date)}  ·  ${ts(due_date)}.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'priority') {
      const code     = options.getString('codice').toUpperCase();
      const priorita = options.getString('priorita');
      const task     = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, flags: MessageFlags.Ephemeral });
      db.prepare('UPDATE tasks SET priority=?, updated_at=? WHERE code=?').run(priorita, now(), code);
      const updated = db.prepare('SELECT * FROM tasks WHERE code=?').get(code);
      const channel = await guild.channels.fetch(task.channel_id).catch(() => null);
      if (channel && task.message_id) {
        const msg = await channel.messages.fetch(task.message_id).catch(() => null);
        if (msg) await msg.edit({ embeds: [buildTaskEmbed(updated)], components: buildTaskButtons(updated) }).catch(() => {});
      }
      await logEvent(guild, `${PRIORITY_EMOJI[priorita]} Priorità **${code}** → **${priorita.toUpperCase()}** da <@${interaction.user.id}>`);
      return interaction.reply({ content: `${PRIORITY_EMOJI[priorita]} Priorità di **${code}** → **${priorita.toUpperCase()}**.` });
    }

    if (sub === 'search') {
      const query = options.getString('query').toLowerCase();
      const tasks = db.prepare(`
        SELECT * FROM tasks
        WHERE LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(code) LIKE ? OR LOWER(tags) LIKE ?
        ORDER BY created_at DESC LIMIT 15
      `).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
      if (!tasks.length) return interaction.reply({ content: `🔍 Nessun risultato per: **${query}**`, flags: MessageFlags.Ephemeral });
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [new EmbedBuilder()
          .setColor(COLOR.purple)
          .setTitle(`🔍  Risultati per "${query}"`)
          .setDescription(tasks.map(t =>
            `${STATUS_EMOJI[t.status]} ${PRIORITY_EMOJI[t.priority]} **\`${t.code}\`** ${t.title.slice(0,60)}`
          ).join('\n'))
          .setFooter({ text: `${tasks.length} risultati` })
        ]
      });
    }

    if (sub === 'stats') {
      const s = {
        total:     db.prepare('SELECT COUNT(*) as c FROM tasks').get().c,
        open:      db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='open'").get().c,
        inprog:    db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='in_progress'").get().c,
        blocked:   db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='blocked'").get().c,
        reviewing: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='reviewing'").get().c,
        completed: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='completed'").get().c,
        cancelled: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='cancelled'").get().c,
        critical:  db.prepare("SELECT COUNT(*) as c FROM tasks WHERE priority IN ('critical','high') AND status NOT IN ('completed','cancelled')").get().c,
        overdue:   db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE due_date < ${now()} AND status NOT IN ('completed','cancelled')`).get().c,
        projects:  db.prepare("SELECT COUNT(*) as c FROM projects WHERE status='active'").get().c,
        tickets:   db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='open'").get().c,
      };
      const top  = db.prepare("SELECT assigned_to, COUNT(*) as cnt FROM tasks WHERE assigned_to IS NOT NULL AND status NOT IN ('completed','cancelled') GROUP BY assigned_to ORDER BY cnt DESC LIMIT 1").get();
      const rate = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0;

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLOR.gold)
          .setTitle('📊  E.C.H.O. — Statistiche Complete')
          .addFields(
            { name: '📈 Avanzamento globale', value: `\`${progressBar(s.completed, s.total)}\``, inline: false },
            { name: '📋 Totali',         value: `\`${s.total}\``,     inline: true },
            { name: '🔵 Aperti',         value: `\`${s.open}\``,      inline: true },
            { name: '🟡 In Progress',    value: `\`${s.inprog}\``,    inline: true },
            { name: '🔍 In Review',      value: `\`${s.reviewing}\``, inline: true },
            { name: '🔴 Bloccati',       value: `\`${s.blocked}\``,   inline: true },
            { name: '✅ Completati',      value: `\`${s.completed}\``, inline: true },
            { name: '🚫 Annullati',      value: `\`${s.cancelled}\``, inline: true },
            { name: '🚨 Critici attivi', value: `\`${s.critical}\``,  inline: true },
            { name: '⚠️ Scaduti',        value: `\`${s.overdue}\``,   inline: true },
            { name: '📁 Progetti',       value: `\`${s.projects}\``,  inline: true },
            { name: '🎫 Ticket aperti',  value: `\`${s.tickets}\``,   inline: true },
            ...(top ? [{ name: '🏆 Membro più carico', value: `<@${top.assigned_to}>  ·  \`${top.cnt} task\``, inline: false }] : [])
          )
          .setFooter({ text: 'E.C.H.O. Smart Dispatcher v3.0' })
          .setTimestamp()
        ]
      });
    }

    if (sub === 'digest') {
      await sendDailyDigest(guild, interaction);
    }
  }
});

// ══════════════════════════════════════════════════════════════
//  DAILY DIGEST
// ══════════════════════════════════════════════════════════════
async function sendDailyDigest(guild, interaction = null) {
  const open     = db.prepare("SELECT * FROM tasks WHERE status='open' ORDER BY created_at ASC LIMIT 10").all();
  const blocked  = db.prepare("SELECT * FROM tasks WHERE status='blocked'").all();
  const overdue  = db.prepare(`SELECT * FROM tasks WHERE due_date < ${now()} AND status NOT IN ('completed','cancelled')`).all();
  const critical = db.prepare("SELECT * FROM tasks WHERE priority IN ('critical','high') AND status NOT IN ('completed','cancelled') ORDER BY created_at ASC LIMIT 5").all();
  const tickets  = db.prepare("SELECT * FROM tickets WHERE status='open' ORDER BY created_at ASC LIMIT 5").all();

  const total = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
  const done  = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='completed'").get().c;

  const embed = new EmbedBuilder()
    .setColor(COLOR.cyan)
    .setTitle('📅  E.C.H.O. — Digest Giornaliero')
    .setDescription(`\`${progressBar(done, total)}\`  ·  ${done}/${total} task completati`)
    .setTimestamp();

  if (overdue.length)  embed.addFields({ name: `⚠️ Scaduti (${overdue.length})`,           value: overdue.map(t  => `\`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (blocked.length)  embed.addFields({ name: `🔴 Bloccati (${blocked.length})`,          value: blocked.map(t  => `\`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (critical.length) embed.addFields({ name: `🔥 Alta priorità (${critical.length})`,    value: critical.map(t => `${PRIORITY_EMOJI[t.priority]} \`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (open.length)     embed.addFields({ name: `🔵 Task aperti (${open.length})`,          value: open.map(t     => `\`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (tickets.length)  embed.addFields({ name: `🎫 Ticket in attesa (${tickets.length})`,  value: tickets.map(t  => `\`${t.code}\` ${t.tg_name || t.tg_username || 'N/A'}`).join('\n').slice(0,1024) });

  if (!embed.data.fields?.length)
    embed.setDescription(`\`${progressBar(done, total)}\`  ·  ${done}/${total} task completati\n\n🎉 Tutto in ordine — Team in forma!`);

  embed.setFooter({ text: 'E.C.H.O. Smart Dispatcher v3.0  ·  Digest automatico' });

  if (interaction) return interaction.reply({ embeds: [embed] });
  if (CH_LOG) {
    const ch = await guild.channels.fetch(CH_LOG).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════
//  CRON JOBS
// ══════════════════════════════════════════════════════════════
function startCronJobs(guild) {
  // Ogni minuto — reminder scadenze
  cron.schedule('* * * * *', async () => {
    const due = db.prepare('SELECT * FROM reminders WHERE remind_at<=? AND sent=0').all(now());
    for (const r of due) {
      const task = db.prepare('SELECT * FROM tasks WHERE code=?').get(r.task_code);
      if (!task) continue;
      const target = task.thread_id || CH_LOG;
      if (!target) continue;
      const ch = await guild.channels.fetch(target).catch(() => null);
      if (!ch) continue;
      const mention = task.assigned_to ? `<@${task.assigned_to}>` : (ROLE_OPS ? `<@&${ROLE_OPS}>` : '');
      await ch.send({
        content: mention || undefined,
        embeds: [new EmbedBuilder()
          .setColor(COLOR.amber)
          .setTitle('⏰  Reminder Scadenza')
          .setDescription(`Task **${task.code}** — ${task.title}\nScade ${ts(task.due_date)}  ·  ${tsF(task.due_date)}`)
          .setFooter({ text: `E.C.H.O. Smart Dispatcher  ·  ${task.code}` })
        ],
        allowedMentions: { users: task.assigned_to ? [task.assigned_to] : [], roles: ROLE_OPS && !task.assigned_to ? [ROLE_OPS] : [] }
      }).catch(() => {});
      db.prepare('UPDATE reminders SET sent=1 WHERE id=?').run(r.id);
    }
  });

  // Ogni 30 min — escalation task critici non assegnati
  cron.schedule('*/30 * * * *', async () => {
    const tasks = db.prepare(`
      SELECT * FROM tasks WHERE priority IN ('critical','high')
      AND assigned_to IS NULL AND status='open' AND created_at < ?
    `).all(now() - 7200);

    for (const t of tasks) {
      if (!CH_LOG) continue;
      const ch = await guild.channels.fetch(CH_LOG).catch(() => null);
      if (!ch) continue;
      await ch.send({
        content: ROLE_EXECUTIVE ? `<@&${ROLE_EXECUTIVE}>` : undefined,
        embeds: [new EmbedBuilder()
          .setColor(COLOR.red)
          .setTitle('🚨  Escalation — Task Non Assegnato')
          .setDescription(`Task ${PRIORITY_EMOJI[t.priority]} **${t.code}** non è assegnato da più di 2 ore.\n\n**${t.title}**`)
          .setFooter({ text: `E.C.H.O. Smart Dispatcher  ·  ${t.code}` })
          .setTimestamp()
        ],
        allowedMentions: { roles: ROLE_EXECUTIVE ? [ROLE_EXECUTIVE] : [] }
      }).catch(() => {});
    }
  });

  // Ogni giorno alle 09:00
  cron.schedule('0 9 * * *', () => sendDailyDigest(guild));

  console.log('[E.C.H.O.] Cron jobs avviati.');
}

// ══════════════════════════════════════════════════════════════
//  GITHUB WEBHOOK + HTTP SERVER
// ══════════════════════════════════════════════════════════════
function startWebhookServer() {
  const server = http.createServer(async (req, res) => {
    // Health check Railway
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', bot: client.user?.tag || 'starting', uptime: client.uptime }));
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
            const task = db.prepare('SELECT * FROM tasks WHERE UPPER(code)=?').get(code.toUpperCase());
            if (task) await updateTaskStatus(guild, task.code, 'completed', 'github');
          }
          if (CH_LOG) {
            const ch = await guild.channels.fetch(CH_LOG).catch(() => null);
            if (ch) await ch.send({
              embeds: [new EmbedBuilder()
                .setColor(COLOR.grey)
                .setDescription(`📦 **GitHub Push**  ·  \`${payload.repository?.full_name}\`\n\`${commit.id.slice(0,7)}\`  ${commit.message.split('\n')[0].slice(0,100)}  ·  **${commit.author?.name}**`)
              ]
            }).catch(() => {});
          }
        }
      }

      if (event === 'issues' && payload.action === 'opened') {
        await createTask(
          guild, CH_BUG_TRACKER || CH_TASK_BOARD,
          `[GitHub] ${payload.issue.title}`,
          payload.issue.body?.slice(0,500) || '',
          'github', { category: 'bug', priority: 'high' }
        );
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
if (!TOKEN) { console.error('[E.C.H.O.] DISCORD_TOKEN mancante nel .env!'); process.exit(1); }
client.login(TOKEN);
