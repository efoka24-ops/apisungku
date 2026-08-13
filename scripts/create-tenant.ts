/**
 * Cree un projet client et sa premiere cle API.
 *
 *   npm run tenant:create -- --name "Sungku" --slug sungku \
 *     --webhook https://sungku.cm/api/paiements/webhook
 *
 * La cle en clair n'est affichee qu'une fois : elle n'est pas stockee.
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { generateApiKey } from '../src/auth/api-key.util';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const name = arg('name');
  const slug = arg('slug');
  const webhookUrl = arg('webhook');

  if (!name || !slug) {
    console.error('Usage : --name "Nom du projet" --slug identifiant [--webhook URL]');
    process.exit(1);
  }

  const salt = process.env.API_KEY_SALT;
  if (!salt) {
    console.error('API_KEY_SALT doit etre defini (voir .env).');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const env = process.env.PAWAPAY_BASE_URL?.includes('sandbox') ? 'test' : 'live';

  const webhookSecret = randomBytes(32).toString('hex');
  const key = generateApiKey(salt, env);

  const tenant = await prisma.tenant.create({
    data: {
      name,
      slug,
      webhookUrl: webhookUrl ?? null,
      webhookSecret,
      apiKeys: {
        create: { prefix: key.prefix, hash: key.hash, label: 'cle initiale' },
      },
    },
  });

  console.log('\nProjet cree.\n');
  console.log(`  Nom            : ${tenant.name}`);
  console.log(`  Identifiant    : ${tenant.id}`);
  console.log(`  Webhook        : ${tenant.webhookUrl ?? '(non configure)'}`);
  console.log('\n  Cle API        :', key.plaintext);
  console.log('  Secret webhook :', webhookSecret);
  console.log(
    '\nCes deux valeurs ne seront plus jamais affichees. Enregistrez-les' +
      '\nmaintenant dans le stockage de secrets du projet client.\n',
  );

  await prisma.$disconnect();
}

void main();
