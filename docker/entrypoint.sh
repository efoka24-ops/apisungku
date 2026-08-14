#!/bin/sh
# Demarrage du conteneur : attendre la base, mettre le schema a niveau, lancer
# le service. Ecrit en sh POSIX (l'image est une alpine, sans bash).
set -e

PRISMA="./node_modules/.bin/prisma"

log() {
  echo "[entrypoint] $1"
}

# ─── 1. Attendre que la base accepte les connexions ──────────────────────────
# Un conteneur de base de donnees demarre rarement avant l'application. Sans
# cette attente, le premier demarrage echoue systematiquement au premier
# deploiement d'une pile neuve.
log "Attente de la base de donnees..."
i=1
while [ "$i" -le 30 ]; do
  if node -e "
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    p.\$queryRaw\`SELECT 1\`
      .then(() => p.\$disconnect())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  " 2>/dev/null; then
    log "Base joignable."
    break
  fi
  if [ "$i" -eq 30 ]; then
    log "ECHEC : base injoignable apres 30 tentatives. Verifier DATABASE_URL."
    exit 1
  fi
  i=$((i + 1))
  sleep 2
done

# ─── 2. Mettre le schema a niveau ────────────────────────────────────────────
log "Application des migrations..."
DEPLOY_OUTPUT=$("$PRISMA" migrate deploy 2>&1) || DEPLOY_FAILED=1
echo "$DEPLOY_OUTPUT"

if [ "${DEPLOY_FAILED:-0}" = "1" ]; then
  case "$DEPLOY_OUTPUT" in
    *P3005*)
      # La base contient deja les tables mais aucun historique de migration :
      # typiquement une base creee auparavant avec `prisma db push`. On la
      # marque comme etant a jour au lieu de rejouer des CREATE TABLE qui
      # echoueraient. Aucune donnee n'est touchee.
      log "Base existante sans historique : bascule en mode rattrapage."
      for dir in prisma/migrations/*/; do
        [ -d "$dir" ] || continue
        migration=$(basename "$dir")
        log "  migration $migration marquee comme appliquee"
        "$PRISMA" migrate resolve --applied "$migration"
      done
      log "Rattrapage termine, nouvelle tentative."
      "$PRISMA" migrate deploy
      ;;
    *)
      log "ECHEC de la migration. Le service ne demarre pas : mieux vaut un"
      log "refus net qu'un service tournant sur un schema incoherent."
      exit 1
      ;;
  esac
fi

# ─── 3. Creation optionnelle d'un projet au premier demarrage ────────────────
# Desactive par defaut. Utile pour amorcer un environnement neuf sans avoir a
# ouvrir une session sur le serveur.
#
# ATTENTION : la cle API s'affiche alors dans les journaux du conteneur. A
# reserver a la preproduction, ou a retirer une fois le projet cree.
if [ -n "${BOOTSTRAP_TENANT_SLUG:-}" ]; then
  log "Amorcage du projet ${BOOTSTRAP_TENANT_SLUG}..."
  node dist/cli/create-tenant.js \
    --name "${BOOTSTRAP_TENANT_NAME:-$BOOTSTRAP_TENANT_SLUG}" \
    --slug "$BOOTSTRAP_TENANT_SLUG" \
    ${BOOTSTRAP_TENANT_WEBHOOK:+--webhook "$BOOTSTRAP_TENANT_WEBHOOK"} \
    || log "Amorcage ignore (le projet existe probablement deja)."
fi

# ─── 4. Lancer le service ────────────────────────────────────────────────────
log "Demarrage de l'application."
exec node dist/main.js
