# Zero-dependency Node server — no npm install, no build step.
FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json index.js db.js ./
COPY public ./public

USER node

CMD ["node", "index.js"]
