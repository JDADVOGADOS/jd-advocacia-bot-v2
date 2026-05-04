FROM node:20-slim

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y \
    openssl \
    git \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8080

CMD ["node", "index.js"]
