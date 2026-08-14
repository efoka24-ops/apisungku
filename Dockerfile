# ─── Build ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json nest-cli.json ./
COPY src ./src
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
COPY docker/entrypoint.sh ./docker/entrypoint.sh
# chmod explicite : le bit d'execution des fichiers du depot ne survit pas
# toujours a un clone sous Windows.
RUN chmod +x ./docker/entrypoint.sh

# Le service ne tourne pas en root.
USER node
EXPOSE 3000

# Attente de la base, mise a niveau du schema, puis demarrage. Un deploiement
# ne doit jamais laisser le schema en retard sur le code.
ENTRYPOINT ["/bin/sh", "./docker/entrypoint.sh"]
