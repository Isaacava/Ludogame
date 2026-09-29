FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY admin ./admin
COPY web ./web

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server/index.js"]
