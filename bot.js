// ╔══════════════════════════════════════════════════════╗
// ║   E.C.H.O. Smart Dispatcher — Single File Edition   ║
// ║   E.O.N.D. Core v1.0 (sql.js version)               ║
// ╚══════════════════════════════════════════════════════╝
//
// DIPENDENZE:
//   npm install discord.js sql.js node-cron dotenv
//
// AVVIO:
//   node bot.js
// ═══════════════════════════════════════════════════════

require('dotenv').config();

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, SlashCommandBuilder, REST, Routes,
  Events
} = require('discord.js');

const cron = require('node-cron');

// ─────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────
const CONFIG = {
  token:          process.env.DISCORD_TOKEN,
  clientId:       process.env.DISCORD_CLIENT_ID,
  guildId:        process.env.DISCORD_GUILD_ID,

  channels: {
    taskBoard:    process.env.CHANNEL_TASK_BOARD,
    bugTracker:   process.env.CHANNEL_BUG_TRACKER,
    devRequests:  process.env.CHANNEL_DEV_REQUESTS,
    log:          process.env.CHANNEL_LOG,
  },

  roles: {
    executive:    process.env.ROLE_EXECUTIVE,
    ops:          process.env.ROLE_OPS,
  },

  dbFile: process.env.DB_FILE || 'echo_dispatcher.db',
};

// ─────────────────────────────────────────────────────
//  DATABASE WRAPPER for sql.js
// ─────────────────────────────────────────────────────
class SqlDatabase {
  constructor(SQL, dbPath) {
    this.SQL = SQL;
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const data = fs.readFileSync(this.dbPath);
        this.db = new this.SQL.Database(data);
      } else {
        this.db = new this.SQL.Database();
      }
    } catch (e) {
      this.db = new this.SQL.Database();
    }
  }

  save() {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (e) {
      console.error('[DB] Error saving:', e);
    }
  }

  exec(sql) {
    this.db.run(sql);
    this.save();
  }

  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        try {
          const stmt = self.db.prepare(sql);
          stmt.bind(params);
          stmt.step();
          stmt.free();
          self.save();
          return { lastInsertRowid: null };
        } catch (e) {
          console.error('[DB] Error in run:', e);
          return { lastInsertRowid: null };
        }
      },
      get(...params) {
        try {
          const stmt = self.db.prepare(sql);
          stmt.bind(params);
          if (stmt.step()) {
            const result = stmt.getAsObject();
            stmt.free();
            return result;
          }
          stmt.free();
          return null;
        } catch (e) {
          console.error('[DB] Error in get:', e);
          return null;
        }
      },
      all(...params) {
        try {
          const stmt = self.db.prepare(sql);
          stmt.bind(params);
          const results = [];
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
          return results;
        } catch (e) {
          console.error('[DB] Error in all:', e);
          return [];
        }
      }
    };
  }

  pragma() { /* no-op for sql.js */ }
}

let db;
let SQL;

// ─────────────────────────────────────────────────────
//  PRIORITY & ANALYSIS ENGINE
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
  { re: /questa settimana|this week/i,      h: 96   },
];

function analyzePriority(content) {
  const t = content.toLowerCase();
  let score = 0;
  let dueDate = null;

  HIGH_KW.forEach(kw => { if (t.includes(kw)) score += 3; });
  LOW_KW.forEach(kw => { if (t.includes(kw)) score -= 2; });

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

  let category = 'task';
  if (/\bbug\b|crash|errore|error|exception/.test(t))    category = 'bug';
  else if (/feature|funzionalità|aggiunta|aggiungi/.test(t)) category = 'feature';
  else if (/richiesta|request|chiede|serve|bisogno/.test(t)) category = 'request';

  const priority = score >= 4 ? 'high' : score <= -1 ? 'low' : 'medium';
  return { priority, category, dueDate };
}

// ─────────────────────────────────────────────────────
//  DISCORD CLIENT SETUP
// ─────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

const rest = new REST({ version: '10' }).setToken(CONFIG.token);

// ─────────────────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────────────────
async function main() {
  try {
    // Initialize SQL.js
    SQL = await initSqlJs();
    db = new SqlDatabase(SQL, CONFIG.dbFile);
    await db.init();

    console.log('[DB] Database initialized');

    // Create tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        task_code     TEXT UNIQUE NOT NULL,
        title         TEXT NOT NULL,
        description   TEXT,
        priority      TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
        status        TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','blocked','completed','cancelled')),
        category      TEXT DEFAULT 'task' CHECK(category IN ('task','bug','feature','request')),
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

    console.log('[DB] Tables initialized');

    // Register slash commands
    try {
      await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), {
        body: [
          new SlashCommandBuilder().setName('tasks').setDescription('Mostra tutti i task'),
          new SlashCommandBuilder().setName('task').setDescription('Dettagli di un task').addStringOption(opt => opt.setName('code').setDescription('Codice task').setRequired(true)),
        ]
      });
      console.log('[Discord] Slash commands registered');
    } catch (e) {
      console.error('[Discord] Error registering commands:', e);
    }

    // Discord events
    client.on(Events.ClientReady, () => {
      console.log(`\n${'═'.repeat(56)}`);
      console.log(`[E.O.N.D.] ✅ Online come ${client.user.tag}`);
      console.log(`[Discord] ✅ Comandi slash registrati`);
      console.log(`[E.O.N.D.] 🟢 Sistema attivo`);
      console.log(`${'═'.repeat(56)}\n`);
    });

    client.on(Events.InteractionCreate, async interaction => {
      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === 'tasks') {
        const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 5').all();
        const embed = new EmbedBuilder()
          .setTitle('📋 Ultimi Task')
          .setColor(0x00aaff);
        
        if (tasks.length === 0) {
          embed.setDescription('Nessun task');
        } else {
          tasks.forEach(t => {
            embed.addFields({
              name: `${t.task_code} - ${t.title}`,
              value: `Priority: **${t.priority}** | Status: **${t.status}**`,
              inline: false
            });
          });
        }
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === 'task') {
        const code = interaction.options.getString('code');
        const task = db.prepare('SELECT * FROM tasks WHERE task_code = ?').get(code);
        
        if (!task) {
          await interaction.reply({ content: `❌ Task ${code} non trovato`, ephemeral: true });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(`${task.task_code} - ${task.title}`)
          .addFields(
            { name: 'Priority', value: task.priority, inline: true },
            { name: 'Status', value: task.status, inline: true },
            { name: 'Category', value: task.category, inline: true },
            { name: 'Description', value: task.description || 'N/A' }
          )
          .setColor(0x00aaff);

        await interaction.reply({ embeds: [embed], ephemeral: true });
      }
    });

    // Login
    await client.login(CONFIG.token);
  } catch (error) {
    console.error('[ERROR]', error);
    process.exit(1);
  }
}

main();
