FROM node:24-alpine

# Installa le dipendenze di sistema necessarie per compilare better-sqlite3
RUN apk add --no-cache python3 make g++ cairo-dev jpeg-dev pango-dev giflib-dev pixman-dev

WORKDIR /app

# Copia package.json
COPY package.json ./

# Installa le dipendenze con build tools disponibili
RUN npm install --production

# Copia il resto dell'app
COPY . .

# Espone la porta se necessario (Discord.js non ha bisogno di porta)
# Avvia il bot
CMD ["node", "bot.js"]
