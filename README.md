# apisungku

Passerelle de paiement mobile money, mutualisée entre plusieurs projets.

Un seul service parle à pawaPay. Les projets — Sungku, KoliGo, les suivants —
appellent cette API avec leur clé, sans jamais connaître l'opérateur derrière,
ni détenir le token pawaPay.

```
Sungku ─┐
KoliGo ─┼──►  apisungku  ──►  pawaPay  ──►  MTN / Orange / …
Projet3 ─┘        │
                  ├─ une clé API par projet
                  ├─ transactions persistées + réconciliation automatique
                  ├─ une seule URL de callback déclarée chez pawaPay
                  └─ webhooks signés vers chaque projet
```

Ajouter un projet ne demande **aucune** reconfiguration côté pawaPay : on crée
un tenant, on lui donne une clé, c'est tout.

---

## Démarrage

```bash
cp .env.example .env      # puis renseigner PAWAPAY_API_TOKEN et API_KEY_SALT
npm install
npx prisma migrate dev --name init
npm run start:dev
```

Documentation interactive : <http://localhost:3000/docs>

Avec Docker (base PostgreSQL locale incluse) :

```bash
docker compose -f docker-compose.dev.yml up --build
```

`docker-compose.yml` sans suffixe est la composition du **serveur** : elle tire
l'image publiée sur `ghcr.io` et ne contient pas de base. Ne pas l'utiliser en
local.

### Créer un projet client

En local :

```bash
npm run tenant:create -- --name "Sungku" --slug sungku \
  --webhook https://sungku.cm/api/paiements/webhook
```

Sur le serveur, la même commande dans le conteneur :

```bash
docker exec <conteneur> node dist/cli/create-tenant.js \
  --name "Sungku" --slug sungku --webhook https://sungku.cm/api/paiements/webhook
```

La clé API s'affiche **une seule fois** — seul son hachage est conservé. Relancer
la commande sur un slug existant n'échoue pas : elle ajoute une clé
supplémentaire, ce qui en fait aussi l'outil de rotation. Le secret de webhook,
lui, n'est jamais régénéré : le changer casserait la vérification de signature
côté projet client, sans prévenir.

### Déclarer le callback chez pawaPay

Dans le dashboard pawaPay, enregistrer ces trois URL :

```
https://votre-domaine/v1/callbacks/pawapay/deposits
https://votre-domaine/v1/callbacks/pawapay/payouts
https://votre-domaine/v1/callbacks/pawapay/refunds
```

Renseigner `PAWAPAY_CALLBACK_SECRET` et configurer l'en-tête `X-Callback-Secret`
correspondant si votre compte le permet.

---

## API

Toutes les routes sont préfixées par `/v1` et authentifiées par l'en-tête
`X-Api-Key` (ou `Authorization: Bearer`).

| Méthode | Route | Rôle |
|---|---|---|
| `POST` | `/v1/deposits` | Encaisser |
| `POST` | `/v1/payouts` | Reverser |
| `POST` | `/v1/refunds` | Rembourser |
| `GET` | `/v1/transactions` | Lister |
| `GET` | `/v1/transactions/:id` | Consulter |
| `GET` | `/v1/toolkit/providers` | Opérateurs actifs, devises, bornes de montant |
| `GET` | `/v1/toolkit/availability` | Disponibilité des opérateurs |
| `POST` | `/v1/toolkit/predict-provider` | Valider un numéro, deviner l'opérateur |
| `GET` | `/v1/health` | Sonde de santé |

### Encaisser

```bash
curl -X POST https://votre-domaine/v1/deposits \
  -H "X-Api-Key: sk_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "5000",
    "currency": "XAF",
    "phoneNumber": "237670000000",
    "reference": "cagnotte-142-contribution-8891",
    "metadata": { "cagnotteId": 142 }
  }'
```

```json
{
  "id": "afb57b93-7849-49aa-babb-4c3ccbfe3d79",
  "type": "DEPOSIT",
  "status": "PROCESSING",
  "amount": "5000",
  "currency": "XAF",
  "provider": "MTN_MOMO_CMR",
  "reference": "cagnotte-142-contribution-8891",
  "failure": null,
  "createdAt": "2026-08-13T09:12:04.000Z",
  "completedAt": null
}
```

`provider` est déduit du numéro si vous ne le précisez pas. `reference` est
unique par projet : réutiliser la même référence renvoie la transaction
existante au lieu d'en créer une seconde — c'est votre garde-fou contre les
doubles soumissions de formulaire.

### Statuts

| Statut | Signification |
|---|---|
| `PENDING` | Créée chez nous, issue chez pawaPay encore inconnue |
| `PROCESSING` | Acceptée, en attente de l'autorisation du client |
| `COMPLETED` | Fonds effectivement déplacés |
| `FAILED` | Échec **prouvé** — aucun mouvement de fonds |
| `NEEDS_ATTENTION` | Issue indéterminée. **Ne jamais traiter comme un échec** |

`PENDING` et `PROCESSING` ne sont pas finaux. `NEEDS_ATTENTION` non plus : il
signale une transaction que le service n'a pas pu trancher et qui demande une
vérification humaine.

---

## Webhooks

Chaque transaction qui atteint un statut final déclenche un appel `POST` vers
l'URL du projet, avec ces en-têtes :

```
X-Apisungku-Event:     deposit.completed
X-Apisungku-Delivery:  <id unique, utilisable pour dédupliquer>
X-Apisungku-Timestamp: <epoch secondes>
X-Apisungku-Signature: sha256=<hmac>
```

La signature se vérifie ainsi :

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifier(corpsBrut: string, timestamp: string, signature: string) {
  // Rejeter les requêtes trop anciennes : sans cela, une signature valide
  // capturée peut être rejouée indéfiniment.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const attendu = 'sha256=' + createHmac('sha256', SECRET_WEBHOOK)
    .update(`${timestamp}.${corpsBrut}`)
    .digest('hex');

  const a = Buffer.from(attendu);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Vérifiez la signature sur le **corps brut**, avant tout parsing JSON.

Répondez `2xx`. Toute autre réponse déclenche un réessai avec backoff
exponentiel (1 min, 2, 4, 8… plafonné à 6 h), jusqu'à `WEBHOOK_MAX_ATTEMPTS`.

---

## Ce qui protège votre argent

Trois mécanismes, à comprendre avant de modifier le code :

**L'identifiant est créé avant l'appel sortant.** Chaque transaction est
persistée en base *avant* que quoi que ce soit ne parte vers pawaPay. Une
coupure réseau au pire moment laisse donc toujours une trace exploitable —
c'est ce qui rend la réconciliation possible.

**`FAILED` exige une preuve.** Un timeout, un HTTP 500 ou un `UNKNOWN_ERROR`
ne prouvent rien : l'argent a peut-être bougé. Seuls un rejet explicite ou un
`NOT_FOUND` à la vérification autorisent à conclure à l'échec. Dans le doute,
la transaction reste en attente puis passe en `NEEDS_ATTENTION`.

**Les callbacks ne sont pas crus sur parole.** À réception d'un callback, le
service interroge pawaPay pour connaître l'état réel avant de toucher au
statut. Un callback falsifié, dupliqué ou arrivé dans le désordre ne peut donc
pas corrompre les données.

À cela s'ajoute un cycle de réconciliation toutes les 5 minutes sur les
transactions en attente depuis plus de 15 minutes : même en perdant tous les
callbacks, aucune transaction ne reste bloquée.

---

## Passage en production

1. Terminer l'onboarding sur le compte pawaPay pour débloquer la production.
2. Générer un **nouveau** token depuis le dashboard de production.
3. Basculer `PAWAPAY_BASE_URL` sur `https://api.pawapay.io`.
4. Régénérer les clés API des projets (elles porteront le préfixe `sk_live_`).
5. Déclarer les URL de callback de production.

`API_KEY_SALT` ne doit **jamais** changer après création des clés : toutes les
clés existantes deviendraient invalides d'un coup.

## Démarrage automatique du conteneur

`docker/entrypoint.sh` s'exécute à chaque démarrage et enchaîne :

1. **attente de la base** — jusqu'à 30 tentatives. Sans cela, le tout premier
   démarrage d'une pile neuve échoue systématiquement, la base n'étant pas
   encore prête ;
2. **mise à niveau du schéma** via `migrate deploy`. Si la base contient déjà
   les tables sans historique de migration — typiquement une base créée avec
   `prisma db push` — l'erreur `P3005` est rattrapée automatiquement : les
   migrations sont marquées comme appliquées plutôt que rejouées. Aucune donnée
   n'est touchée ;
3. **amorçage optionnel d'un projet**, si `BOOTSTRAP_TENANT_SLUG` est défini ;
4. **démarrage** du service.

Toute autre erreur de migration arrête le démarrage : mieux vaut un refus net
qu'un service tournant sur un schéma incohérent.

L'amorçage automatique s'active ainsi :

```bash
BOOTSTRAP_TENANT_SLUG=sungku
BOOTSTRAP_TENANT_NAME=Sungku
BOOTSTRAP_TENANT_WEBHOOK=https://sungku.cm/api/paiements/webhook
```

⚠️ La clé API apparaît alors **dans les journaux du conteneur**. À réserver à la
préproduction, et à retirer une fois le projet créé.

## Déploiement

Chaque poussée sur `preprod` ou `main` déclenche le pipeline : vérification,
construction de l'image, publication sur `ghcr.io`, puis déploiement SSH et
contrôle que le service répond.

Sur le serveur, un seul dossier à préparer (celui de `DEPLOY_PATH`) contenant
`docker-compose.yml` et un `.env`. Le pipeline ne réécrit **que** la ligne
`APISUNGKU_TAG` de ce `.env` : les secrets applicatifs y restent intacts et ne
transitent jamais par GitHub.

À définir dans *Settings → Secrets and variables → Actions* :

| | |
|---|---|
| Secrets | `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`, `DEPLOY_PATH`, `GHCR_USERNAME`, `GHCR_TOKEN` |
| Variables | `HEALTHCHECK_URL` |

`GHCR_TOKEN` est un token personnel avec la portée `read:packages`, utilisé par
le serveur pour tirer l'image.

## Tests

```bash
npm test
```
