FROM node:24-bookworm-slim

WORKDIR /app

# Copia e installa dipendenze
COPY package.json ./
RUN npm install --production

# Copia il resto dell'app
COPY . .

# Avvia il bot
CMD ["node", "bot.js"]
