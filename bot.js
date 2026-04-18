// ============================================================
//  E.C.H.O. — Smart Dispatcher v2.1
//  Single-file bot | SQLite | discord.js v14
// ============================================================

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ThreadAutoArchiveDuration
} = require('discord.js');
const Database = require('better-sqlite3');
const cron     = require('node-cron');
const http     = require('http');
const crypto   = require('crypto');
const path     = require('path');

// ─── ENV ────────────────────────────────────────────────────
const TOKEN           = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.DISCORD_CLIENT_ID;
const GUILD_ID        = process.env.DISCORD_GUILD_ID;
const CH_TASK_BOARD   = process.env.CHANNEL_TASK_BOARD;
const CH_BUG_TRACKER  = process.env.CHANNEL_BUG_TRACKER;
const CH_DEV_REQUESTS = process.env.CHANNEL_DEV_REQUESTS;
const CH_LOG          = process.env.CHANNEL_LOG;
const ROLE_EXECUTIVE  = process.env.ROLE_EXECUTIVE;
const ROLE_OPS        = process.env.ROLE_OPS;
const GH_SECRET       = process.env.GITHUB_WEBHOOK_SECRET || null;
const WEBHOOK_PORT    = process.env.WEBHOOK_PORT || 3001;

// DB_PATH: su Railway imposta questa variabile su /data/dispatcher.db
// (dopo aver aggiunto un Volume montato in /data)
// In locale lascia vuoto: usa dispatcher.db nella cartella del progetto
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'dispatcher.db');

// ─── DATABASE ────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    UNIQUE NOT NULL,
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
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_code  TEXT    NOT NULL,
    author_id  TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_counter (
    id  INTEGER PRIMARY KEY CHECK (id = 1),
    val INTEGER DEFAULT 0
  );

  INSERT OR IGNORE INTO task_counter VALUES (1, 0);

  CREATE TABLE IF NOT EXISTS reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_code  TEXT    NOT NULL,
    remind_at  INTEGER NOT NULL,
    sent       INTEGER DEFAULT 0
  );
`);

// ─── HELPERS ─────────────────────────────────────────────────
function nextCode() {
  db.prepare('UPDATE task_counter SET val = val + 1 WHERE id = 1').run();
  const { val } = db.prepare('SELECT val FROM task_counter WHERE id = 1').get();
  return `T-${String(val).padStart(3, '0')}`;
}

function now()  { return Math.floor(Date.now() / 1000); }
function ts(u)  { return `<t:${u}:R>`; }
function tsF(u) { return `<t:${u}:F>`; }

// Formatta autore: ID Discord → menzione, 'github' → testo plain
function fmtActor(actorId) {
  if (!actorId || actorId === 'github') return '**GitHub**';
  if (/^\d{15,20}$/.test(actorId))      return `<@${actorId}>`;
  return `**${actorId}**`;
}

const PRIORITY_COLORS = { critical: 0xFF0000, high: 0xFF6B35, medium: 0xF39C12, low: 0x27AE60 };
const PRIORITY_EMOJI  = { critical: '🚨', high: '🔥', medium: '❗', low: '⏳' };
const STATUS_EMOJI    = { open: '🔵', in_progress: '🟡', blocked: '🔴', completed: '✅', cancelled: '🚫', reviewing: '🔍' };
const CATEGORY_EMOJI  = { bug: '🐛', feature: '✨', task: '📋', request: '📨', urgent: '⚡', docs: '📝' };

// ─── PRIORITY ENGINE ─────────────────────────────────────────
function analyzePriority(text) {
  const t = text.toLowerCase();
  const CRITICAL = ['critico','critical','production down','hotfix','emergenza','impossibile usare'];
  const HIGH     = ['urgente','urgent','bug','crash','broken','non funziona','bloccato','asap','entro oggi','errore','error'];
  const LOW      = ['migliora','miglioramento','improve','enhancement','idea','quando puoi','bassa priorit','opzionale','optional'];
  if (CRITICAL.some(k => t.includes(k))) return 'critical';
  if (HIGH.some(k => t.includes(k)))     return 'high';
  if (LOW.some(k => t.includes(k)))      return 'low';
  return 'medium';
}

function analyzeCategory(text) {
  const t = text.toLowerCase();
  if (t.includes('bug') || t.includes('fix') || t.includes('crash') || t.includes('errore')) return 'bug';
  if (t.includes('feature') || t.includes('aggiungi') || t.includes('implement'))             return 'feature';
  if (t.includes('richiesta') || t.includes('request') || t.includes('cliente'))              return 'request';
  if (t.includes('urgente') || t.includes('critico') || t.includes('asap'))                   return 'urgent';
  if (t.includes('doc') || t.includes('readme') || t.includes('guida'))                       return 'docs';
  return 'task';
}

function parseDeadline(text) {
  const t = text.toLowerCase();
  const d = new Date();
  if (t.includes('oggi')       || t.includes('today'))    { d.setHours(23,59,0,0); return Math.floor(d/1000); }
  if (t.includes('domani')     || t.includes('tomorrow')) { d.setDate(d.getDate()+1); d.setHours(23,59,0,0); return Math.floor(d/1000); }
  if (t.includes('dopodomani'))                            { d.setDate(d.getDate()+2); d.setHours(23,59,0,0); return Math.floor(d/1000); }
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

// ─── EMBED + BUTTONS ─────────────────────────────────────────
function buildTaskEmbed(task) {
  const color  = PRIORITY_COLORS[task.priority] || 0x5865F2;
  const pEmoji = PRIORITY_EMOJI[task.priority]  || '❓';
  const sEmoji = STATUS_EMOJI[task.status]       || '❓';
  const cEmoji = CATEGORY_EMOJI[task.category]   || '📋';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${cEmoji} \`${task.code}\` — ${task.title}`)
    .addFields(
      { name: '📊 Stato',     value: `${sEmoji} ${task.status.replace(/_/g,' ').toUpperCase()}`, inline: true },
      { name: '🎯 Priorità',  value: `${pEmoji} ${task.priority.toUpperCase()}`,                  inline: true },
      { name: '🏷️ Tipo',      value: `${cEmoji} ${task.category.toUpperCase()}`,                  inline: true },
      { name: '👤 Assegnato', value: task.assigned_to ? `<@${task.assigned_to}>` : '_Nessuno_',   inline: true },
      { name: '📅 Creato',    value: tsF(task.created_at),                                         inline: true }
    );

  if (task.description) embed.setDescription(task.description);
  if (task.due_date)    embed.addFields({ name: '⏰ Scadenza', value: `${tsF(task.due_date)} (${ts(task.due_date)})` });

  embed.setFooter({ text: `E.C.H.O. Smart Dispatcher • ${task.code}` }).setTimestamp();
  return embed;
}

function buildTaskButtons(task) {
  const closed = task.status === 'completed' || task.status === 'cancelled';
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`task_take_${task.code}`).setLabel('Prendo in carico').setStyle(ButtonStyle.Primary).setEmoji('🙋').setDisabled(closed),
      new ButtonBuilder().setCustomId(`task_done_${task.code}`).setLabel('Completato').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(closed),
      new ButtonBuilder().setCustomId(`task_block_${task.code}`).setLabel('Bloccato').setStyle(ButtonStyle.Danger).setEmoji('🔴').setDisabled(closed),
      new ButtonBuilder().setCustomId(`task_review_${task.code}`).setLabel('In Review').setStyle(ButtonStyle.Secondary).setEmoji('🔍').setDisabled(closed)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`task_cancel_${task.code}`).setLabel('Annulla').setStyle(ButtonStyle.Secondary).setEmoji('🚫').setDisabled(closed),
      new ButtonBuilder().setCustomId(`task_info_${task.code}`).setLabel('Dettagli').setStyle(ButtonStyle.Secondary).setEmoji('📋')
    )
  ];
}

// ─── CORE ────────────────────────────────────────────────────
async function createTask(guild, channelId, title, description, createdBy, opts = {}) {
  const code     = nextCode();
  const priority = opts.priority || analyzePriority(title + ' ' + description);
  const category = opts.category || analyzeCategory(title + ' ' + description);
  const due_date = opts.due_date !== undefined ? opts.due_date : parseDeadline(title + ' ' + description);
  const t        = now();

  db.prepare(`
    INSERT INTO tasks (code,title,description,priority,category,status,created_by,channel_id,due_date,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(code, title, description, priority, category, 'open', createdBy, channelId, due_date, t, t);

  const task    = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return task;

  const msg = await channel.send({ embeds: [buildTaskEmbed(task)], components: buildTaskButtons(task) });

  let thread = null;
  try {
    thread = await msg.startThread({
      name: `${code} — ${title.slice(0, 90)}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek
    });
    await thread.send(
      `🧵 Thread di lavoro per **${code}**\n` +
      `Creato da ${fmtActor(createdBy)} ${ts(t)}\n` +
      `Usa questo thread per aggiornamenti e note.`
    );
  } catch (_) {}

  db.prepare('UPDATE tasks SET thread_id=?, message_id=?, updated_at=? WHERE code=?')
    .run(thread?.id || null, msg.id, now(), code);

  if (due_date) {
    const remindAt = due_date - 3600;
    if (remindAt > now()) db.prepare('INSERT INTO reminders (task_code,remind_at) VALUES (?,?)').run(code, remindAt);
  }

  await logEvent(guild, `📋 Task **${code}** creato da ${fmtActor(createdBy)} | ${PRIORITY_EMOJI[priority]} ${priority.toUpperCase()} | ${title}`);
  return task;
}

async function updateTaskStatus(guild, code, newStatus, actorId) {
  const task = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);
  if (!task) return null;

  db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE code=?').run(newStatus, now(), code);
  const updated = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);

  const channel = await guild.channels.fetch(task.channel_id).catch(() => null);
  if (channel && task.message_id) {
    const msg = await channel.messages.fetch(task.message_id).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildTaskEmbed(updated)], components: buildTaskButtons(updated) }).catch(() => {});
  }

  if (task.thread_id) {
    const thread = await guild.channels.fetch(task.thread_id).catch(() => null);
    if (thread) {
      await thread.send(
        `${STATUS_EMOJI[newStatus]} **Stato** → \`${newStatus.replace(/_/g,' ').toUpperCase()}\` da ${fmtActor(actorId)} ${ts(now())}`
      ).catch(() => {});
    }
  }

  await logEvent(guild, `${STATUS_EMOJI[newStatus]} Task **${code}** → **${newStatus.toUpperCase()}** da ${fmtActor(actorId)}`);
  return updated;
}

async function assignTask(guild, code, userId, actorId) {
  const task = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);
  if (!task) return null;

  db.prepare('UPDATE tasks SET assigned_to=?, status=?, updated_at=? WHERE code=?')
    .run(userId, 'in_progress', now(), code);
  const updated = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);

  const channel = await guild.channels.fetch(task.channel_id).catch(() => null);
  if (channel && task.message_id) {
    const msg = await channel.messages.fetch(task.message_id).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildTaskEmbed(updated)], components: buildTaskButtons(updated) }).catch(() => {});
  }

  if (task.thread_id) {
    const thread = await guild.channels.fetch(task.thread_id).catch(() => null);
    if (thread) await thread.send(`👤 Task assegnato a <@${userId}> da ${fmtActor(actorId)} ${ts(now())}`).catch(() => {});
  }

  await logEvent(guild, `👤 Task **${code}** assegnato a <@${userId}> da ${fmtActor(actorId)}`);
  return updated;
}

async function logEvent(guild, message) {
  if (!CH_LOG) return;
  const ch = await guild.channels.fetch(CH_LOG).catch(() => null);
  if (ch) await ch.send(`\`${new Date().toISOString().slice(0,19)}\` ${message}`).catch(() => {});
}

// ─── SLASH COMMANDS ──────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('task')
    .setDescription('Gestione task E.C.H.O.')
    .addSubcommand(s => s
      .setName('create').setDescription('Crea un nuovo task manualmente')
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
      .addUserOption(o => o.setName('assegna').setDescription('Assegna subito a un membro'))
      .addStringOption(o => o.setName('scadenza').setDescription('Es: "domani", "in 3 giorni", "in 5 ore"'))
    )
    .addSubcommand(s => s
      .setName('list').setDescription('Lista task')
      .addStringOption(o => o.setName('filtro').setDescription('Filtra per stato').addChoices(
        {name:'🔵 Open',value:'open'},{name:'🟡 In Progress',value:'in_progress'},
        {name:'🔴 Blocked',value:'blocked'},{name:'🔍 Review',value:'reviewing'},
        {name:'✅ Completed',value:'completed'},{name:'📋 Tutti',value:'all'}
      ))
      .addUserOption(o => o.setName('utente').setDescription('Solo task di un utente'))
    )
    .addSubcommand(s => s
      .setName('assign').setDescription('Assegna un task a un membro')
      .addStringOption(o => o.setName('codice').setDescription('Codice task (es: T-001)').setRequired(true))
      .addUserOption(o => o.setName('utente').setDescription('Membro').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('done').setDescription('Segna un task come completato')
      .addStringOption(o => o.setName('codice').setDescription('Codice task').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('info').setDescription('Dettagli di un task')
      .addStringOption(o => o.setName('codice').setDescription('Codice task').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('note').setDescription('Aggiungi una nota a un task')
      .addStringOption(o => o.setName('codice').setDescription('Codice task').setRequired(true))
      .addStringOption(o => o.setName('testo').setDescription('Testo della nota').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('deadline').setDescription('Imposta/modifica scadenza')
      .addStringOption(o => o.setName('codice').setDescription('Codice task').setRequired(true))
      .addStringOption(o => o.setName('scadenza').setDescription('Es: "domani", "in 2 giorni"').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('priority').setDescription('Cambia priorità di un task')
      .addStringOption(o => o.setName('codice').setDescription('Codice task').setRequired(true))
      .addStringOption(o => o.setName('priorita').setDescription('Nuova priorità').setRequired(true).addChoices(
        {name:'🚨 Critical',value:'critical'},{name:'🔥 High',value:'high'},
        {name:'❗ Medium',value:'medium'},{name:'⏳ Low',value:'low'}
      ))
    )
    .addSubcommand(s => s
      .setName('search').setDescription('Cerca task per parola chiave')
      .addStringOption(o => o.setName('query').setDescription('Parola chiave').setRequired(true))
    )
    .addSubcommand(s => s.setName('stats').setDescription('Statistiche generali'))
    .addSubcommand(s => s.setName('digest').setDescription('Digest manuale task aperti')),

  new SlashCommandBuilder()
    .setName('echo')
    .setDescription('Info sul sistema E.C.H.O.')
    .addSubcommand(s => s.setName('status').setDescription('Stato del sistema'))
    .addSubcommand(s => s.setName('help').setDescription('Guida ai comandi'))
    .addSubcommand(s => s.setName('ping').setDescription('Test latenza bot'))
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

// ─── CLIENT ──────────────────────────────────────────────────
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

client.once('clientReady', async () => {
  console.log(`[E.C.H.O.] Online: ${client.user.tag}`);
  console.log(`[E.C.H.O.] DB path: ${DB_PATH}`);
  client.user.setActivity('⚙️ E.O.N.D. Core | /task', { type: 4 });
  await registerCommands();
  startCronJobs();
  startWebhookServer();
});

// ─── AUTO-TASK ───────────────────────────────────────────────
const MONITORED = () => [CH_TASK_BOARD, CH_BUG_TRACKER, CH_DEV_REQUESTS].filter(Boolean);

client.on('messageCreate', async (msg) => {
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

// ─── REAZIONI ────────────────────────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  const task = db.prepare('SELECT * FROM tasks WHERE message_id = ?').get(reaction.message.id);
  if (!task) return;
  const map = { '✅': 'completed', '🔴': 'blocked', '🚫': 'cancelled', '🔍': 'reviewing' };
  const newStatus = map[reaction.emoji.name];
  if (newStatus) await updateTaskStatus(reaction.message.guild, task.code, newStatus, user.id);
});

// ─── INTERAZIONI ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  const guild = interaction.guild;

  // BOTTONI
  if (interaction.isButton()) {
    const parts     = interaction.customId.split('_');
    const btnAction = parts[1];
    const btnCode   = parts.slice(2).join('_');

    const task = db.prepare('SELECT * FROM tasks WHERE code = ?').get(btnCode);
    if (!task) return interaction.reply({ content: '❌ Task non trovato.', ephemeral: true });

    if (btnAction === 'take') {
      if (task.assigned_to === interaction.user.id)
        return interaction.reply({ content: '⚠️ Sei già assegnato a questo task.', ephemeral: true });
      await assignTask(guild, btnCode, interaction.user.id, interaction.user.id);
      return interaction.reply({ content: `✅ Hai preso in carico **${btnCode}**.`, ephemeral: true });
    }
    if (btnAction === 'done') {
      await updateTaskStatus(guild, btnCode, 'completed', interaction.user.id);
      return interaction.reply({ content: `✅ Task **${btnCode}** completato.`, ephemeral: true });
    }
    if (btnAction === 'block') {
      await updateTaskStatus(guild, btnCode, 'blocked', interaction.user.id);
      return interaction.reply({ content: `🔴 Task **${btnCode}** bloccato.`, ephemeral: true });
    }
    if (btnAction === 'review') {
      await updateTaskStatus(guild, btnCode, 'reviewing', interaction.user.id);
      return interaction.reply({ content: `🔍 Task **${btnCode}** in review.`, ephemeral: true });
    }
    if (btnAction === 'cancel') {
      await updateTaskStatus(guild, btnCode, 'cancelled', interaction.user.id);
      return interaction.reply({ content: `🚫 Task **${btnCode}** annullato.`, ephemeral: true });
    }
    if (btnAction === 'info') {
      const t     = db.prepare('SELECT * FROM tasks WHERE code = ?').get(btnCode);
      const notes = db.prepare('SELECT * FROM task_notes WHERE task_code = ? ORDER BY created_at DESC LIMIT 5').all(btnCode);
      const embed = buildTaskEmbed(t);
      if (notes.length)
        embed.addFields({ name: '📝 Ultime note', value: notes.map(n => `${fmtActor(n.author_id)} ${ts(n.created_at)}: ${n.content}`).join('\n').slice(0,1024) });
      if (t.thread_id)
        embed.addFields({ name: '🧵 Thread', value: `<#${t.thread_id}>`, inline: true });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    return interaction.reply({ content: '❓ Azione non riconosciuta.', ephemeral: true });
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName, options } = interaction;

  // /echo
  if (commandName === 'echo') {
    const sub = options.getSubcommand();
    if (sub === 'ping') {
      return interaction.reply({ content: `🏓 Pong! **${Date.now()-interaction.createdTimestamp}ms** | WS: **${client.ws.ping}ms**`, ephemeral: true });
    }
    if (sub === 'status') {
      const s = {
        total:     db.prepare('SELECT COUNT(*) as c FROM tasks').get().c,
        open:      db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='open'").get().c,
        progress:  db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='in_progress'").get().c,
        blocked:   db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='blocked'").get().c,
        completed: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='completed'").get().c,
      };
      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0x00A3FF).setTitle('⚙️ E.C.H.O. Smart Dispatcher — Status')
          .addFields(
            { name: '📋 Totali',      value: `${s.total}`,     inline: true },
            { name: '🔵 Aperti',      value: `${s.open}`,      inline: true },
            { name: '🟡 In Progress', value: `${s.progress}`,  inline: true },
            { name: '🔴 Bloccati',    value: `${s.blocked}`,   inline: true },
            { name: '✅ Completati',   value: `${s.completed}`, inline: true },
            { name: '🤖 Online da',   value: ts(Math.floor((Date.now()-client.uptime)/1000)), inline: true }
          ).setFooter({ text: 'E.C.H.O. v2.1 • E.O.N.D. Core' }).setTimestamp()
      ]});
    }
    if (sub === 'help') {
      return interaction.reply({ ephemeral: true, embeds: [
        new EmbedBuilder().setColor(0xD4AF37).setTitle('📖 E.C.H.O. — Guida Comandi')
          .setDescription('Scrivi nei canali monitorati per creare task automaticamente, oppure usa `/task create`.')
          .addFields(
            { name: '📋 Task', value:
              '`/task create` · `/task list` · `/task assign` · `/task done`\n' +
              '`/task info` · `/task note` · `/task deadline` · `/task priority`\n' +
              '`/task search` · `/task stats` · `/task digest`'
            },
            { name: '⚡ Reazioni rapide', value: '✅ Completa · 🔴 Blocca · 🚫 Annulla · 🔍 Review' },
            { name: '🔧 Sistema', value: '`/echo ping` · `/echo status` · `/echo help`' }
          ).setFooter({ text: 'E.C.H.O. Smart Dispatcher v2.1' })
      ]});
    }
  }

  // /task
  if (commandName === 'task') {
    const sub = options.getSubcommand();

    if (sub === 'create') {
      await interaction.deferReply({ ephemeral: true });
      const title    = options.getString('titolo');
      const desc     = options.getString('descrizione') || '';
      const priority = options.getString('priorita')   || undefined;
      const category = options.getString('categoria')  || undefined;
      const assegna  = options.getUser('assegna');
      const scadenza = options.getString('scadenza')   || '';
      const due_date = scadenza ? parseDeadline(scadenza) : undefined;
      const targetCh = CH_TASK_BOARD || interaction.channelId;
      const task     = await createTask(guild, targetCh, title, desc, interaction.user.id, { priority, category, due_date });
      if (assegna) await assignTask(guild, task.code, assegna.id, interaction.user.id);
      return interaction.editReply({ content: `✅ Task **${task.code}** creato${assegna ? ` e assegnato a <@${assegna.id}>` : ''}.` });
    }

    if (sub === 'list') {
      const filtro = options.getString('filtro') || 'open';
      const utente = options.getUser('utente');
      const conds  = [], params = [];
      if (filtro !== 'all') { conds.push('status = ?'); params.push(filtro); }
      if (utente)           { conds.push('assigned_to = ?'); params.push(utente.id); }
      const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
      const tasks = db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC LIMIT 20`).all(...params);
      if (!tasks.length) return interaction.reply({ content: '📭 Nessun task trovato.', ephemeral: true });
      return interaction.reply({ ephemeral: true, embeds: [
        new EmbedBuilder().setColor(0x2F80ED)
          .setTitle(`📋 Task — ${filtro === 'all' ? 'Tutti' : filtro.replace(/_/g,' ').toUpperCase()}`)
          .setDescription(tasks.map(t =>
            `${STATUS_EMOJI[t.status]} ${PRIORITY_EMOJI[t.priority]} **\`${t.code}\`** ${t.title.slice(0,55)}` +
            (t.assigned_to ? ` → <@${t.assigned_to}>` : '') +
            (t.due_date && t.due_date > now() ? ` ⏰${ts(t.due_date)}` : '')
          ).join('\n'))
          .setFooter({ text: `${tasks.length} task trovati` })
      ]});
    }

    if (sub === 'assign') {
      const code   = options.getString('codice').toUpperCase();
      const utente = options.getUser('utente');
      const task   = await assignTask(guild, code, utente.id, interaction.user.id);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, ephemeral: true });
      return interaction.reply({ content: `✅ Task **${code}** assegnato a <@${utente.id}>.` });
    }

    if (sub === 'done') {
      const code = options.getString('codice').toUpperCase();
      const task = await updateTaskStatus(guild, code, 'completed', interaction.user.id);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, ephemeral: true });
      return interaction.reply({ content: `✅ Task **${code}** completato.` });
    }

    if (sub === 'info') {
      const code  = options.getString('codice').toUpperCase();
      const task  = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, ephemeral: true });
      const notes = db.prepare('SELECT * FROM task_notes WHERE task_code = ? ORDER BY created_at DESC LIMIT 5').all(code);
      const embed = buildTaskEmbed(task);
      if (notes.length)
        embed.addFields({ name: '📝 Ultime note', value: notes.map(n => `${fmtActor(n.author_id)} ${ts(n.created_at)}: ${n.content}`).join('\n').slice(0,1024) });
      if (task.thread_id)
        embed.addFields({ name: '🧵 Thread', value: `<#${task.thread_id}>`, inline: true });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'note') {
      const code  = options.getString('codice').toUpperCase();
      const testo = options.getString('testo');
      const task  = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, ephemeral: true });
      db.prepare('INSERT INTO task_notes (task_code,author_id,content,created_at) VALUES (?,?,?,?)').run(code, interaction.user.id, testo, now());
      if (task.thread_id) {
        const thread = await guild.channels.fetch(task.thread_id).catch(() => null);
        if (thread) await thread.send(`📝 **Nota** da <@${interaction.user.id}>:\n> ${testo}`).catch(() => {});
      }
      await logEvent(guild, `📝 Nota su **${code}** da <@${interaction.user.id}>`);
      return interaction.reply({ content: `✅ Nota aggiunta a **${code}**.`, ephemeral: true });
    }

    if (sub === 'deadline') {
      const code     = options.getString('codice').toUpperCase();
      const scadenza = options.getString('scadenza');
      const due_date = parseDeadline(scadenza);
      if (!due_date) return interaction.reply({ content: '❌ Usa "domani", "in 3 giorni", "in 5 ore".', ephemeral: true });
      const task = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, ephemeral: true });
      db.prepare('UPDATE tasks SET due_date=?, updated_at=? WHERE code=?').run(due_date, now(), code);
      const updated = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);
      const channel = await guild.channels.fetch(task.channel_id).catch(() => null);
      if (channel && task.message_id) {
        const msg = await channel.messages.fetch(task.message_id).catch(() => null);
        if (msg) await msg.edit({ embeds: [buildTaskEmbed(updated)], components: buildTaskButtons(updated) }).catch(() => {});
      }
      db.prepare('DELETE FROM reminders WHERE task_code = ?').run(code);
      const remindAt = due_date - 3600;
      if (remindAt > now()) db.prepare('INSERT INTO reminders (task_code,remind_at) VALUES (?,?)').run(code, remindAt);
      return interaction.reply({ content: `⏰ Scadenza di **${code}** → ${tsF(due_date)}.`, ephemeral: true });
    }

    if (sub === 'priority') {
      const code     = options.getString('codice').toUpperCase();
      const priorita = options.getString('priorita');
      const task     = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);
      if (!task) return interaction.reply({ content: `❌ Task \`${code}\` non trovato.`, ephemeral: true });
      db.prepare('UPDATE tasks SET priority=?, updated_at=? WHERE code=?').run(priorita, now(), code);
      const updated = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);
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
        SELECT * FROM tasks WHERE LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(code) LIKE ?
        ORDER BY created_at DESC LIMIT 15
      `).all(`%${query}%`, `%${query}%`, `%${query}%`);
      if (!tasks.length) return interaction.reply({ content: `🔍 Nessun risultato per: **${query}**`, ephemeral: true });
      return interaction.reply({ ephemeral: true, embeds: [
        new EmbedBuilder().setColor(0x8E44AD).setTitle(`🔍 Ricerca: "${query}"`)
          .setDescription(tasks.map(t => `${STATUS_EMOJI[t.status]} ${PRIORITY_EMOJI[t.priority]} **\`${t.code}\`** ${t.title.slice(0,60)}`).join('\n'))
          .setFooter({ text: `${tasks.length} risultati` })
      ]});
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
      };
      const top  = db.prepare("SELECT assigned_to, COUNT(*) as cnt FROM tasks WHERE assigned_to IS NOT NULL AND status NOT IN ('completed','cancelled') GROUP BY assigned_to ORDER BY cnt DESC LIMIT 1").get();
      const rate = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0;
      const embed = new EmbedBuilder().setColor(0xD4AF37).setTitle('📊 E.C.H.O. — Statistiche Task')
        .addFields(
          { name: '📋 Totali',         value: `${s.total}`,     inline: true },
          { name: '🔵 Aperti',         value: `${s.open}`,      inline: true },
          { name: '🟡 In Progress',    value: `${s.inprog}`,    inline: true },
          { name: '🔴 Bloccati',       value: `${s.blocked}`,   inline: true },
          { name: '🔍 In Review',      value: `${s.reviewing}`, inline: true },
          { name: '✅ Completati',      value: `${s.completed}`, inline: true },
          { name: '🚫 Annullati',      value: `${s.cancelled}`, inline: true },
          { name: '🚨 Critici attivi', value: `${s.critical}`,  inline: true },
          { name: '⚠️ Scaduti',        value: `${s.overdue}`,   inline: true },
          { name: '📈 Completamento',  value: `${rate}%`,       inline: true }
        );
      if (top) embed.addFields({ name: '🏆 Più carico', value: `<@${top.assigned_to}> (${top.cnt} task)`, inline: true });
      embed.setFooter({ text: 'E.C.H.O. Smart Dispatcher v2.1' }).setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'digest') {
      await sendDailyDigest(guild, interaction);
    }
  }
});

// ─── DIGEST ──────────────────────────────────────────────────
async function sendDailyDigest(guild, interaction = null) {
  const open     = db.prepare("SELECT * FROM tasks WHERE status='open' ORDER BY created_at ASC LIMIT 10").all();
  const blocked  = db.prepare("SELECT * FROM tasks WHERE status='blocked'").all();
  const overdue  = db.prepare(`SELECT * FROM tasks WHERE due_date < ${now()} AND status NOT IN ('completed','cancelled')`).all();
  const critical = db.prepare("SELECT * FROM tasks WHERE priority IN ('critical','high') AND status NOT IN ('completed','cancelled') ORDER BY created_at ASC LIMIT 5").all();

  const embed = new EmbedBuilder().setColor(0x00A3FF).setTitle('📅 E.C.H.O. — Digest Giornaliero').setTimestamp();
  if (overdue.length)  embed.addFields({ name: `⚠️ Scaduti (${overdue.length})`,        value: overdue.map(t  => `\`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (blocked.length)  embed.addFields({ name: `🔴 Bloccati (${blocked.length})`,       value: blocked.map(t  => `\`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (critical.length) embed.addFields({ name: `🔥 Alta priorità (${critical.length})`, value: critical.map(t => `${PRIORITY_EMOJI[t.priority]} \`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (open.length)     embed.addFields({ name: `🔵 Aperti (${open.length})`,            value: open.map(t     => `\`${t.code}\` ${t.title.slice(0,55)}`).join('\n').slice(0,1024) });
  if (!embed.data.fields?.length) embed.setDescription('🎉 Nessun task aperto, bloccato o scaduto. Team in forma!');

  if (interaction) return interaction.reply({ embeds: [embed] });
  if (CH_LOG) {
    const ch = await guild.channels.fetch(CH_LOG).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

// ─── CRON ────────────────────────────────────────────────────
function startCronJobs() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  cron.schedule('* * * * *', async () => {
    const due = db.prepare('SELECT * FROM reminders WHERE remind_at <= ? AND sent = 0').all(now());
    for (const r of due) {
      const task = db.prepare('SELECT * FROM tasks WHERE code = ?').get(r.task_code);
      if (!task) continue;
      const target = task.thread_id || CH_LOG;
      if (!target) continue;
      const ch = await guild.channels.fetch(target).catch(() => null);
      if (!ch) continue;
      const mention = task.assigned_to ? `<@${task.assigned_to}>` : (ROLE_OPS ? `<@&${ROLE_OPS}>` : '');
      await ch.send({
        content: `⏰ **Reminder** ${mention}: task **${task.code}** — *${task.title}* scade ${ts(task.due_date)}!`,
        allowedMentions: { users: task.assigned_to ? [task.assigned_to] : [], roles: [] }
      }).catch(() => {});
      db.prepare('UPDATE reminders SET sent=1 WHERE id=?').run(r.id);
    }
  });

  cron.schedule('*/30 * * * *', async () => {
    const tasks = db.prepare(`
      SELECT * FROM tasks WHERE priority IN ('critical','high')
      AND assigned_to IS NULL AND status='open' AND created_at < ?
    `).all(now() - 7200);
    for (const t of tasks) {
      if (!CH_LOG) continue;
      const ch = await guild.channels.fetch(CH_LOG).catch(() => null);
      if (!ch) continue;
      const role = ROLE_EXECUTIVE ? `<@&${ROLE_EXECUTIVE}>` : '';
      await ch.send({
        content: `🚨 **ESCALATION** ${role} — **${t.code}** (${PRIORITY_EMOJI[t.priority]}) non assegnato da 2+ ore: *${t.title}*`,
        allowedMentions: { roles: ROLE_EXECUTIVE ? [ROLE_EXECUTIVE] : [] }
      }).catch(() => {});
    }
  });

  cron.schedule('0 9 * * *', () => sendDailyDigest(guild));
  console.log('[E.C.H.O.] Cron jobs avviati.');
}

// ─── GITHUB WEBHOOK ──────────────────────────────────────────
function startWebhookServer() {
  const server = http.createServer(async (req, res) => {
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
            const task = db.prepare('SELECT * FROM tasks WHERE UPPER(code) = ?').get(code.toUpperCase());
            if (task) await updateTaskStatus(guild, task.code, 'completed', 'github');
          }
          if (CH_LOG) {
            const ch = await guild.channels.fetch(CH_LOG).catch(() => null);
            if (ch) await ch.send(
              `📦 **GitHub Push** — \`${payload.repository?.full_name}\`\n` +
              `└ \`${commit.id.slice(0,7)}\` ${commit.message.split('\n')[0].slice(0,100)} — **${commit.author?.name}**`
            ).catch(() => {});
          }
        }
      }

      if (event === 'issues' && payload.action === 'opened') {
        await createTask(
          guild,
          CH_BUG_TRACKER || CH_TASK_BOARD,
          `[GitHub] ${payload.issue.title}`,
          payload.issue.body?.slice(0,500) || '',
          'github',
          { category: 'bug' }
        );
      }

      res.writeHead(200); res.end('OK');
    });
  });
  server.listen(WEBHOOK_PORT, () => console.log(`[E.C.H.O.] Webhook su porta ${WEBHOOK_PORT}`));
}

// ─── BOOT ────────────────────────────────────────────────────
if (!TOKEN) { console.error('[E.C.H.O.] DISCORD_TOKEN mancante!'); process.exit(1); }
client.login(TOKEN);
