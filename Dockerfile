# ─── Build ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ─── Runtime ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist
COPY prisma ./prisma

# Le service ne tourne pas en root.
USER node
EXPOSE 3000

# Les migrations sont appliquees au demarrage : un deploiement ne doit jamais
# laisser le schema en retard sur le code.
# CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main.js"]
