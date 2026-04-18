# ⚙️ E.C.H.O. Smart Dispatcher v2.0

Bot unico, file singolo. Niente configurazione complessa.

---

## 🚀 Setup in 5 minuti

### 1. Requisiti
- Node.js v18+ → https://nodejs.org
- Il file `.env` è già compilato con i tuoi ID

### 2. Installa le dipendenze
```bash
npm install
```

### 3. Avvia il bot
```bash
node bot.js
```

Al primo avvio registra automaticamente i comandi slash su Discord.

---

## 📋 Comandi disponibili

### `/task create` — Crea task manualmente
Campi: titolo (required), descrizione, priorità, categoria, assegna, scadenza

### `/task list` — Lista task
Filtra per: stato, utente

### `/task assign` — Assegna task
```
/task assign codice:T-001 utente:@Mario
```

### `/task done` — Completa task
```
/task done codice:T-001
```

### `/task info` — Dettagli completi + note
### `/task note` — Aggiungi nota a un task
### `/task deadline` — Imposta/modifica scadenza
### `/task priority` — Cambia priorità
### `/task search` — Cerca per parola chiave
### `/task stats` — Statistiche generali
### `/task digest` — Digest manuale dei task aperti

### `/echo status` — Stato del sistema
### `/echo ping` — Latenza bot
### `/echo help` — Guida comandi

---

## ⚡ Auto-task dai canali

Il bot monitora automaticamente:
- `#task-board`
- `#bug-tracker`
- `#dev-requests`

Ogni messaggio in questi canali **diventa automaticamente un task**.

---

## 🎯 Reazioni rapide

Aggiungi reaction al messaggio del task:
- ✅ → Completa
- 🔴 → Blocca
- 🚫 → Annulla
- 🔍 → Metti in review

---

## 🔗 GitHub Webhook (opzionale)

1. Nel `.env`, aggiungi: `GITHUB_WEBHOOK_SECRET=una_password`
2. Nel tuo repo GitHub: Settings → Webhooks → Add webhook
3. URL: `http://tuo-server:3001/webhooks/github`
4. Content type: `application/json`
5. Events: Push + Issues

**Chiudi task con commit:**
```
git commit -m "fix login bug - closes T-001"
```

---

## 🌐 Hosting gratuito

**Railway** (più semplice per iniziare)
1. Crea account su railway.app
2. New Project → Deploy from GitHub
3. Aggiungi le variabili ambiente dal `.env`
4. Deploy automatico

**Oracle Cloud Always Free** (migliore a lungo termine)
- VM Ubuntu gratuita per sempre
- Installa Node.js, clona il repo, `node bot.js`
- Usa `pm2` per tenerlo sempre online: `pm2 start bot.js --name echo-bot`

---

## 🗄️ Database

Il bot usa SQLite (`dispatcher.db`) — nessun setup richiesto.
Il file viene creato automaticamente al primo avvio.

---

## 📁 Struttura

```
echo-bot/
├── bot.js          ← tutto il codice
├── .env            ← configurazione (NON caricare su GitHub)
├── package.json
├── dispatcher.db   ← creato automaticamente
└── README.md
```
