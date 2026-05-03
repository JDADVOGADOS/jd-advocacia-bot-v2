FROM node:20-slim

# Melhor performance e menos lixo
ENV NODE_ENV=production

# Instala dependências essenciais para o Baileys
RUN apt-get update && apt-get install -y \
    openssl \
    git \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia apenas o necessário para instalar dependências
COPY package*.json ./

RUN npm install --omit=dev

# Copia o restante do projeto
COPY . .

EXPOSE 8080

CMD ["node", "index.js"]
