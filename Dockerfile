FROM node:20-slim

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y \
    openssl \
    git \
    openssh-client \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia package.json e package-lock.json
COPY package*.json ./

# Instala dependências
RUN npm install --omit=dev

# Copia TODO o projeto (sem cache)
COPY . .

EXPOSE 8080

CMD ["node", "index.js"]
