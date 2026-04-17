// ╔══════════════════════════════════════════════════════╗
// ║   E.C.H.O. Smart Dispatcher — Single File Edition   ║
// ║   E.O.N.D. Core v1.0                                ║
// ╚══════════════════════════════════════════════════════╝
//
// DIPENDENZE:
//   npm install discord.js better-sqlite3 node-cron dotenv
//
// AVVIO:
//   node bot.js
// ═══════════════════════════════════════════════════════

require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, SlashCommandBuilder, REST, Routes,
  Events
} = require('discord.js');

const Database = require('better-sqlite3');
const cron     = require('node-cron');

// ─────────────────────────────────────────────────────
//  CONFIG — modifica questi valori o usa il file .env
// ─────────────────────────────────────────────────────
const CONFIG = {
  token:          process.env.DISCORD_TOKEN,
  clientId:       process.env.DISCORD_CLIENT_ID,
  guildId:        process.env.DISCORD_GUILD_ID,

  // ID dei canali operativi (copia da Discord: tasto destro → Copy ID)
  channels: {
    taskBoard:    process.env.CHANNEL_TASK_BOARD,
    bugTracker:   process.env.CHANNEL_BUG_TRACKER,
    devRequests:  process.env.CHANNEL_DEV_REQUESTS,
    log:          process.env.CHANNEL_LOG,
  },

  // ID dei ruoli per ping
  roles: {
    executive:    process.env.ROLE_EXECUTIVE,
    ops:          process.env.ROLE_OPS,
  },

  dbFile: process.env.DB_FILE || 'echo_dispatcher.db',
};

// ─────────────────────────────────────────────────────
//  DATABASE (SQLite — file locale, zero configurazione)
// ─────────────────────────────────────────────────────
const db = new Database(CONFIG.dbFile);

// Abilita WAL mode per performance migliori
db.pragma('journal_mode = WAL');

// Creazione tabelle
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_code     TEXT UNIQUE NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT,
    priority      TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
    status        TEXT DEFAULT 'open'
                  CHECK(status IN ('open','in_progress','blocked','completed','cancelled')),
    category      TEXT DEFAULT 'task'
                  CHECK(category IN ('task','bug','feature','request')),
    assigned_to   TEXT,
    created_by    TEXT NOT NULL,
    source_channel TEXT,
    thread_id     TEXT,
    message_id    TEXT,
    due_date      INTEGER,
    completed_at  INTEGER,
    created_at    INTEGER DEFAULT (unixepoch()),
    updated_at    INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    remind_at  INTEGER NOT NULL,
    sent       INTEGER DEFAULT 0,
    type       TEXT DEFAULT 'deadline'
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    task_id    INTEGER,
    actor      TEXT,
    payload    TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS task_seq (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    val INTEGER DEFAULT 0
  );

  INSERT OR IGNORE INTO task_seq (id, val) VALUES (1, 0);
`);

// ─────────────────────────────────────────────────────
//  PRIORITY ENGINE
// ─────────────────────────────────────────────────────
const HIGH_KW  = ['urgente','urgent','crash','critico','critical','broken','rotto',
                  'giù','down','blocca','blocked','asap','subito','immediato',
                  'emergency','produzione','production','non funziona','bug'];
const LOW_KW   = ['quando puoi','bassa priorità','low priority','eventualmente',
                  'futuro','future','nice to have','miglioria','opzionale','idea'];

const DEADLINE_RE = [
  { re: /oggi|today|stasera/i,              h: 8    },
  { re: /domani|tomorrow/i,                 h: 24   },
  { re: /(\d+)\s*ore|(\d+)\s*hours?/i,      h: null },
  { re: /questa settimana|this week/i,       h: 96   },
];

function analyzePriority(content) {
  const t       = content.toLowerCase();
  let score     = 0;
  let dueDate   = null;

  // Keyword score
  HIGH_KW.forEach(kw => { if (t.includes(kw)) score += 3; });
  LOW_KW.forEach(kw  => { if (t.includes(kw)) score -= 2; });

  // Deadline parsing
  for (const { re, h } of DEADLINE_RE) {
    const m = t.match(re);
    if (m) {
      score += 2;
      if (h) {
        dueDate = Date.now() + h * 3_600_000;
      } else if (m[1]) {
        const hours = parseInt(m[1]);
        dueDate = Date.now() + hours * 3_600_000;
        if (hours <= 12) score += 2;
      }
      break;
    }
  }

  // Categoria
  let category = 'task';
  if (/\bbug\b|crash|errore|error|exception/.test(t))    category = 'bug';
  else if (/feature|funzionalità|aggiunta|aggiungi/.test(t)) category = 'feature';
  else if (/richiesta|request|chiede|serve|bisogno/.test(t)) category = 'request';

  const priority = score >= 4 ? 'high' : score <= -1 ? 'low' : 'medium';
  return { priority, category, dueDate };
}

// ─────────────────────────────────────────────────────
//  TASK ENGINE
// ─────────────────────────────────────────────────────
const PRIORITY_EMOJI = { high: '🔥', medium: '❗', low: '⏳' };
const STATUS_EMOJI   = {
  open: '🔵', in_progress: '🟡', blocked: '🔴',
  completed: '✅', cancelled: '⬜'
};
const PRIORITY_COLOR = { high: 0xFF4444, medium: 0xF39C12, low: 0x3498DB };

function nextTaskCode() {
  const update = db.prepare('UPDATE task_seq SET val = val + 1 WHERE id = 1');
  const select = db.prepare('SELECT val FROM task_seq WHERE id = 1');
  update.run();
  const { val } = select.get();
  return `T-${String(val).padStart(3, '0')}`;
}

function createTask({ content, authorId, channelId, messageId, overrides = {} }) {
  const analysis = analyzePriority(content);
  const priority = overrides.priority || analysis.priority;
  const category = overrides.category || analysis.category;
  const dueDate  = overrides.dueDate  || analysis.dueDate;
  const code     = nextTaskCode();
  const title    = content.replace(/\n/g, ' ').trim().slice(0, 80);

  const insert = db.prepare(`
    INSERT INTO tasks (task_code, title, description, priority, category,
                       created_by, source_channel, message_id, due_date)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);

  const info = insert.run(code, title, content, priority, category,
                          authorId, channelId, messageId,
                          dueDate ? Math.floor(dueDate / 1000) : null);

  logEvent('task_created', info.lastInsertRowid, authorId, { priority, category });

  // Reminder automatici se c'è scadenza
  if (dueDate) {
    const oneHourBefore = dueDate - 3_600_000;
    const rInsert = db.prepare('INSERT INTO reminders (task_id, remind_at) VALUES (?,?)');
    if (oneHourBefore > Date.now()) {
      rInsert.run(info.lastInsertRowid, Math.floor(oneHourBefore / 1000));
    }
    rInsert.run(info.lastInsertRowid, Math.floor(dueDate / 1000));
  }

  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
}

function updateStatus(codeOrId, newStatus, actorId) {
  const task = findTask(codeOrId);
  if (!task) throw new Error(`Task non trovato: ${codeOrId}`);

  db.prepare(`
    UPDATE tasks SET status = ?, completed_at = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(newStatus, newStatus === 'completed' ? Math.floor(Date.now()/1000) : null, task.id);

  logEvent('status_changed', task.id, actorId, { from: task.status, to: newStatus });
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
}

function assignTask(codeOrId, userId, actorId) {
  const task = findTask(codeOrId);
  if (!task) throw new Error(`Task non trovato: ${codeOrId}`);
  db.prepare(`UPDATE tasks SET assigned_to = ?, status = 'in_progress',
              updated_at = unixepoch() WHERE id = ?`).run(userId, task.id);
  logEvent('task_assigned', task.id, actorId, { assigned_to: userId });
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
}

function setThread(taskId, threadId) {
  db.prepare('UPDATE tasks SET thread_id = ? WHERE id = ?').run(threadId, taskId);
}

function findTask(idOrCode) {
  const s = String(idOrCode).toUpperCase();
  if (/^T-\d+$/.test(s)) return db.prepare('SELECT * FROM tasks WHERE task_code = ?').get(s);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(parseInt(idOrCode));
}

function listTasks({ status, priority, assignedTo, limit = 20 } = {}) {
  let q    = `SELECT * FROM tasks WHERE status != 'cancelled'`;
  const p  = [];
  if (status)     { q += ` AND status = ?`;     p.push(status);     }
  if (priority)   { q += ` AND priority = ?`;   p.push(priority);   }
  if (assignedTo) { q += ` AND assigned_to = ?`; p.push(assignedTo); }
  q += ` ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         created_at DESC LIMIT ?`;
  p.push(limit);
  return db.prepare(q).all(...p);
}

function logEvent(type, taskId, actor, payload = {}) {
  db.prepare('INSERT INTO events (type, task_id, actor, payload) VALUES (?,?,?,?)')
    .run(type, taskId, actor, JSON.stringify(payload));
}

function buildEmbed(task) {
  const pe  = PRIORITY_EMOJI[task.priority] || '❓';
  const se  = STATUS_EMOJI[task.status]     || '❓';
  const due = task.due_date
    ? `<t:${task.due_date}:R>`
    : 'Nessuna';

  return new EmbedBuilder({
    color:  PRIORITY_COLOR[task.priority] || 0x95A5A6,
    title:  `${pe} ${task.task_code} — ${task.title}`,
    fields: [
      { name: 'Status',    value: `${se} \`${task.status}\``,     inline: true },
      { name: 'Priorità',  value: `${pe} \`${task.priority}\``,   inline: true },
      { name: 'Categoria', value: `\`${task.category}\``,          inline: true },
      { name: 'Scadenza',  value: due,                             inline: true },
      { name: 'Assegnato', value: task.assigned_to
          ? `<@${task.assigned_to}>` : 'Nessuno',                  inline: true },
    ],
    footer: { text: `E.O.N.D. Smart Dispatcher | ${task.task_code}` },
    timestamp: new Date(task.created_at * 1000),
  });
}

function buildButtons(taskCode) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`prog:${taskCode}`).setLabel('In Progress')
      .setStyle(ButtonStyle.Primary).setEmoji('🟡'),
    new ButtonBuilder()
      .setCustomId(`done:${taskCode}`).setLabel('Completato')
      .setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`block:${taskCode}`).setLabel('Bloccato')
      .setStyle(ButtonStyle.Danger).setEmoji('🔴'),
  );
}

// ─────────────────────────────────────────────────────
//  DISCORD CLIENT
// ─────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Reaction],
});

// Canali operativi: messaggi qui → task automatico
const TASK_CHANNELS = () => new Set(
  Object.values(CONFIG.channels).filter(Boolean)
    .filter(id => id !== CONFIG.channels.log)
);

// ── Ready ──────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`\n[E.O.N.D.] ✅ Online come ${client.user.tag}`);
  await registerSlashCommands();
  startReminderCron();
  console.log('[E.O.N.D.] 🚀 Sistema attivo\n');
});

// ── Messaggi → task ────────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot)                        return;
  if (!TASK_CHANNELS().has(msg.channelId))   return;
  if (msg.content.startsWith('//'))          return; // commento: non diventa task
  if (msg.content.length < 5)               return;

  try {
    const task = createTask({
      content:   msg.content,
      authorId:  msg.author.id,
      channelId: msg.channelId,
      messageId: msg.id,
    });

    // Thread dedicato
    const thread = await msg.startThread({
      name:                `${task.task_code} — ${task.title.slice(0, 50)}`,
      autoArchiveDuration: 1440,
    });
    setThread(task.id, thread.id);

    // Embed + bottoni nel thread
    await thread.send({ embeds: [buildEmbed(task)], components: [buildButtons(task.task_code)] });

    // Reazione sull'originale
    await msg.react(PRIORITY_EMOJI[task.priority] || '📌');

  } catch (err) {
    console.error('[Task] Errore creazione:', err.message);
  }
});

// ── Reazioni → cambio stato ────────────────────────
const REACTION_TO_STATUS = { '✅': 'completed', '🚫': 'cancelled', '🔴': 'blocked' };

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }

  const newStatus = REACTION_TO_STATUS[reaction.emoji.name];
  if (!newStatus) return;

  const row = db.prepare('SELECT task_code FROM tasks WHERE message_id = ?')
                .get(reaction.message.id);
  if (!row) return;

  try {
    updateStatus(row.task_code, newStatus, user.id);
    await reaction.message.reply(
      `${STATUS_EMOJI[newStatus]} **${row.task_code}** → \`${newStatus}\` da <@${user.id}>`
    );
  } catch (err) {
    console.error('[Reaction] Errore:', err.message);
  }
});

// ── Interactions (slash + bottoni) ────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── Bottoni inline ──────────────────────────────
  if (interaction.isButton()) {
    const [action, taskCode] = interaction.customId.split(':');
    const statusMap = { prog: 'in_progress', done: 'completed', block: 'blocked' };

    if (!statusMap[action]) return;
    try {
      const updated = updateStatus(taskCode, statusMap[action], interaction.user.id);
      await interaction.update({
        embeds:     [buildEmbed(updated)],
        components: [buildButtons(taskCode)],
      });
    } catch (err) {
      await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  if (commandName !== 'task') return;

  const sub = interaction.options.getSubcommand();

  // /task create
  if (sub === 'create') {
    const title       = interaction.options.getString('title');
    const description = interaction.options.getString('description') || title;
    const priority    = interaction.options.getString('priority') || undefined;
    const assignTo    = interaction.options.getUser('assign_to');
    const dueDateStr  = interaction.options.getString('due_date');
    
    try {
      const overrides = {};
      if (priority) overrides.priority = priority;
      
      // Parse della scadenza se fornita
      if (dueDateStr) {
        const t = dueDateStr.toLowerCase();
        let dueDate = null;
        for (const { re, h } of DEADLINE_RE) {
          const m = t.match(re);
          if (m) {
            if (h) {
              dueDate = Date.now() + h * 3_600_000;
            } else if (m[1]) {
              const hours = parseInt(m[1]);
              dueDate = Date.now() + hours * 3_600_000;
            }
            break;
          }
        }
        if (dueDate) overrides.dueDate = dueDate;
      }
      
      const task = createTask({
        content: description,
        authorId: interaction.user.id,
        channelId: interaction.channelId,
        messageId: interaction.id,
        overrides
      });
      
      // Assegna il task se specificato
      if (assignTo) {
        assignTask(task.task_code, assignTo.id, interaction.user.id);
      }
      
      const finalTask = findTask(task.id);
      const embed = buildEmbed(finalTask);
      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      return interaction.reply({ content: `❌ Errore creazione task: ${err.message}`, ephemeral: true });
    }
  }

  // /task list
  if (sub === 'list') {
    await interaction.deferReply({ ephemeral: true });
    const priority = interaction.options.getString('priority') || undefined;
    const tasks    = listTasks({ priority, limit: 10 });
    if (!tasks.length) return interaction.editReply('Nessun task trovato.');

    const lines = tasks.map(t =>
      `${PRIORITY_EMOJI[t.priority]} \`${t.task_code}\` ${t.title.slice(0,45)} — ${STATUS_EMOJI[t.status]} \`${t.status}\``
    ).join('\n');
    return interaction.editReply(`**Task attivi:**\n${lines}`);
  }

  // /task assign
  if (sub === 'assign') {
    const code   = interaction.options.getString('code').toUpperCase();
    const target = interaction.options.getUser('user');
    try {
      assignTask(code, target.id, interaction.user.id);
      return interaction.reply(`✅ **${code}** assegnato a <@${target.id}>`);
    } catch (err) {
      return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
  }

  // /task done
  if (sub === 'done') {
    const code = interaction.options.getString('code').toUpperCase();
    try {
      updateStatus(code, 'completed', interaction.user.id);
      return interaction.reply(`✅ **${code}** completato.`);
    } catch (err) {
      return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
  }

  // /task info
  if (sub === 'info') {
    const code = interaction.options.getString('code').toUpperCase();
    const task = findTask(code);
    if (!task) return interaction.reply({ content: `❌ ${code} non trovato.`, ephemeral: true });
    return interaction.reply({ embeds: [buildEmbed(task)], ephemeral: true });
  }

  // /task stats
  if (sub === 'stats') {
    const s = db.prepare(`
      SELECT
        SUM(status='open')        AS open,
        SUM(status='in_progress') AS in_prog,
        SUM(status='blocked')     AS blocked,
        SUM(status='completed')   AS done,
        SUM(priority='high' AND status NOT IN ('completed','cancelled')) AS high_pending
      FROM tasks
    `).get();

    const embed = new EmbedBuilder({
      color: 0x00A3FF,
      title: '📊 E.C.H.O. — Statistiche Task',
      fields: [
        { name: '🔵 Aperti',       value: String(s.open    || 0), inline: true },
        { name: '🟡 In Progress',  value: String(s.in_prog || 0), inline: true },
        { name: '🔴 Bloccati',     value: String(s.blocked || 0), inline: true },
        { name: '✅ Completati',   value: String(s.done    || 0), inline: true },
        { name: '🔥 High Pending', value: String(s.high_pending || 0), inline: true },
      ],
      footer: { text: 'E.O.N.D. Smart Dispatcher' },
      timestamp: new Date(),
    });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ─────────────────────────────────────────────────────
//  REMINDER CRON
// ─────────────────────────────────────────────────────
function startReminderCron() {
  // Ogni minuto: reminder in scadenza
  cron.schedule('* * * * *', async () => {
    const now     = Math.floor(Date.now() / 1000);
    const pending = db.prepare(`
      SELECT r.*, t.task_code, t.title, t.assigned_to,
             t.thread_id, t.priority, t.status
      FROM reminders r JOIN tasks t ON t.id = r.task_id
      WHERE r.sent = 0 AND r.remind_at <= ?
        AND t.status NOT IN ('completed','cancelled')
    `).all(now);

    for (const row of pending) {
      const target = row.assigned_to
        ? `<@${row.assigned_to}>`
        : CONFIG.roles.ops ? `<@&${CONFIG.roles.ops}>` : '@ops';

      const content = `⏰ **Reminder** — \`${row.task_code}\`: **${row.title}**\nScadenza raggiunta. ${target}`;

      const channelId = row.thread_id || CONFIG.channels.taskBoard;
      try {
        const ch = await client.channels.fetch(channelId);
        await ch.send(content);
      } catch {}

      db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(row.id);
    }
  });

  // Ogni 30 min: escalation
  cron.schedule('*/30 * * * *', async () => {
    const now = Math.floor(Date.now() / 1000);
    const exec = CONFIG.roles.executive ? `<@&${CONFIG.roles.executive}>` : '@executive';

    // HIGH non assegnati da 2h
    const unassigned = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'open' AND priority = 'high'
        AND assigned_to IS NULL
        AND created_at < ? - 7200
    `).all(now);

    for (const t of unassigned) {
      try {
        const ch = await client.channels.fetch(CONFIG.channels.log || CONFIG.channels.taskBoard);
        await ch.send(`🚨 **Escalation** — \`${t.task_code}\` (HIGH) non assegnato da 2h+. ${exec}`);
      } catch {}
    }

    // in_progress fermi da 48h
    const stale = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'in_progress' AND updated_at < ? - 172800
    `).all(now);

    for (const t of stale) {
      try {
        const ch = await client.channels.fetch(CONFIG.channels.log || CONFIG.channels.taskBoard);
        await ch.send(`⚠️ **Escalation** — \`${t.task_code}\` fermo da 48h. ${exec}`);
      } catch {}
    }
  });

  // Ogni giorno 09:00: digest
  cron.schedule('0 9 * * *', async () => {
    if (!CONFIG.channels.log) return;

    const s = db.prepare(`
      SELECT
        SUM(status='open')        AS open,
        SUM(status='in_progress') AS in_prog,
        SUM(status='blocked')     AS blocked,
        SUM(priority='high' AND status NOT IN ('completed','cancelled')) AS high_pending,
        SUM(due_date < unixepoch() AND status NOT IN ('completed','cancelled')) AS overdue
      FROM tasks
    `).get();

    const embed = new EmbedBuilder({
      color: 0x00A3FF,
      title: '📊 Daily Digest — E.C.H.O. Ops',
      fields: [
        { name: '🔵 Aperti',       value: String(s.open         || 0), inline: true },
        { name: '🟡 In Progress',  value: String(s.in_prog      || 0), inline: true },
        { name: '🔴 Bloccati',     value: String(s.blocked      || 0), inline: true },
        { name: '🔥 High Pending', value: String(s.high_pending || 0), inline: true },
        { name: '⏰ Scaduti',      value: String(s.overdue      || 0), inline: true },
      ],
      timestamp: new Date(),
      footer: { text: 'E.O.N.D. Smart Dispatcher' },
    });

    try {
      const ch = await client.channels.fetch(CONFIG.channels.log);
      await ch.send({ embeds: [embed] });
    } catch {}
  });
}

// ─────────────────────────────────────────────────────
//  SLASH COMMANDS
// ─────────────────────────────────────────────────────
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('task')
      .setDescription('Gestisci i task E.C.H.O.')
      .addSubcommand(s => s.setName('create').setDescription('Crea un nuovo task')
        .addStringOption(o => o.setName('title').setDescription('Titolo del task').setRequired(true))
        .addStringOption(o => o.setName('description').setDescription('Descrizione dettagliata').setRequired(false))
        .addStringOption(o => o.setName('priority').setDescription('Priorità').setRequired(false)
          .addChoices(
            { name: '🔥 High',   value: 'high'   },
            { name: '❗ Medium', value: 'medium' },
            { name: '⏳ Low',    value: 'low'    },
          ))
        .addUserOption(o => o.setName('assign_to').setDescription('Assegna a un membro').setRequired(false))
        .addStringOption(o => o.setName('due_date').setDescription('Scadenza (es. oggi, domani, 24 ore)').setRequired(false)))
      .addSubcommand(s => s.setName('list').setDescription('Lista task attivi')
        .addStringOption(o => o.setName('priority').setDescription('Filtra priorità')
          .addChoices(
            { name: '🔥 High',   value: 'high'   },
            { name: '❗ Medium', value: 'medium' },
            { name: '⏳ Low',    value: 'low'    },
          )))
      .addSubcommand(s => s.setName('assign').setDescription('Assegna task a un membro')
        .addStringOption(o => o.setName('code').setDescription('Codice task (es. T-001)').setRequired(true))
        .addUserOption(o   => o.setName('user').setDescription('Membro').setRequired(true)))
      .addSubcommand(s => s.setName('done').setDescription('Segna task come completato')
        .addStringOption(o => o.setName('code').setDescription('Codice task').setRequired(true)))
      .addSubcommand(s => s.setName('info').setDescription('Dettagli di un task')
        .addStringOption(o => o.setName('code').setDescription('Codice task').setRequired(true)))
      .addSubcommand(s => s.setName('stats').setDescription('Statistiche generali'))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(CONFIG.token);
  await rest.put(
    Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId),
    { body: commands }
  );
  console.log('[Discord] ✅ Comandi slash registrati');
}

// ─────────────────────────────────────────────────────
//  AVVIO
// ─────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════╗');
console.log('║   E.O.N.D. Smart Dispatcher      ║');
console.log('╚══════════════════════════════════╝\n');

client.login(CONFIG.token).catch(err => {
  console.error('[FATAL] Login fallito:', err.message);
  process.exit(1);
});
