/**
 * Creation d'un projet client et de sa cle API.
 *
 *   node dist/cli/create-tenant.js --name "Sungku" --slug sungku \
 *     [--webhook https://sungku.cm/api/paiements/webhook]
 *
 * Compile dans l'image : contrairement a un script ts-node, il reste
 * utilisable en production, ou les dependances de developpement sont absentes.
 *
 * Idempotent sur le slug : relance sur un projet existant, il ajoute une
 * nouvelle cle plutot que d'echouer, ce qui en fait aussi l'outil de rotation.
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { generateApiKey } from '../auth/api-key.util';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const name = arg('name');
  const slug = arg('slug');
  const webhookUrl = arg('webhook');

  if (!name || !slug) {
    console.error(
      'Usage : node dist/cli/create-tenant.js --name "Nom" --slug identifiant [--webhook URL]',
    );
    process.exit(1);
  }

  const salt = process.env.API_KEY_SALT;
  if (!salt) {
    console.error('API_KEY_SALT doit etre defini dans l\'environnement.');
    process.exit(1);
  }

  const env = process.env.PAWAPAY_BASE_URL?.includes('sandbox') ? 'test' : 'live';
  const prisma = new PrismaClient();
  const key = generateApiKey(salt, env);

  const existing = await prisma.tenant.findUnique({ where: { slug } });

  const tenant = existing
    ? await prisma.tenant.update({
        where: { slug },
        data: {
          // Le secret de webhook n'est jamais regenere : le projet client
          // l'utilise pour verifier nos signatures, le changer casserait sa
          // verification sans prevenir.
          ...(webhookUrl ? { webhookUrl } : {}),
          apiKeys: {
            create: { prefix: key.prefix, hash: key.hash, label: 'cle ajoutee' },
          },
        },
      })
    : await prisma.tenant.create({
        data: {
          name,
          slug,
          webhookUrl: webhookUrl ?? null,
          webhookSecret: randomBytes(32).toString('hex'),
          apiKeys: {
            create: { prefix: key.prefix, hash: key.hash, label: 'cle initiale' },
          },
        },
      });

  const fresh = await prisma.tenant.findUniqueOrThrow({ where: { slug } });

  console.log(existing ? '\nCle ajoutee au projet existant.\n' : '\nProjet cree.\n');
  console.log(`  Nom            : ${tenant.name}`);
  console.log(`  Identifiant    : ${tenant.id}`);
  console.log(`  Webhook        : ${tenant.webhookUrl ?? '(non configure)'}`);
  console.log(`\n  API_KEY        : ${key.plaintext}`);
  console.log(`  WEBHOOK_SECRET : ${fresh.webhookSecret}`);
  console.log(
    '\nLa cle n\'est affichee qu\'ici : seul son hachage est conserve.' +
      '\nEnregistrez-la maintenant dans le stockage de secrets du projet client.\n',
  );

  await prisma.$disconnect();
}

void main().catch(async (error) => {
  console.error('Echec de la creation :', error);
  process.exit(1);
});
