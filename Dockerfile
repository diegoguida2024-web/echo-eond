FROM node:24-bookworm-slim

# Installa le dipendenze di sistema necessarie per compilare better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia solo package.json prima
COPY package.json ./

# Installa le dipendenze e forza il rebuild di moduli nativi
RUN npm install --build-from-source

# Copia il resto dell'app
COPY . .

# Avvia il bot
CMD ["node", "bot.js"]
