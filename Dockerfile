FROM devlikeapro/waha:noweb

WORKDIR /codeplay

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY web ./web

ENV NODE_ENV=production
EXPOSE 3000 3001

CMD ["node","/codeplay/server/runCombined.js"]
