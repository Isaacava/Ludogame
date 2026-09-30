FROM devlikeapro/waha:gows-2026.9.1

WORKDIR /codeplay

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY web ./web

ENV NODE_ENV=production
EXPOSE 3000 3001

VOLUME ["/app/.sessions"]

CMD ["node","/codeplay/server/runCombined.js"]
