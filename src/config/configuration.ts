/**
 * Toute la configuration passe par des variables d'environnement, sans valeur
 * par defaut pour les secrets : le service refuse de demarrer plutot que de
 * tourner avec un token vide.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variable d'environnement manquante : ${name}. Voir .env.example.`,
    );
  }
  return value;
}

export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',

  apiKeySalt: required('API_KEY_SALT'),

  // Ouvre l'enrolement des projets par HTTP. Non definie, la creation de
  // projet est refusee : mieux vaut un service ferme qu'un service ou
  // n'importe qui peut declencher des mouvements de fonds.
  adminApiKey: process.env.ADMIN_API_KEY ?? '',

  pawapay: {
    baseUrl: (process.env.PAWAPAY_BASE_URL ?? 'https://api.sandbox.pawapay.io')
      .replace(/\/+$/, ''),
    apiToken: required('PAWAPAY_API_TOKEN'),
    timeoutMs: parseInt(process.env.PAWAPAY_TIMEOUT_MS ?? '15000', 10),
    callbackSecret: process.env.PAWAPAY_CALLBACK_SECRET ?? '',
  },

  reconciliation: {
    afterMinutes: parseInt(process.env.RECONCILE_AFTER_MINUTES ?? '15', 10),
    maxAttempts: 20,
  },

  webhooks: {
    maxAttempts: parseInt(process.env.WEBHOOK_MAX_ATTEMPTS ?? '8', 10),
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS ?? '10000', 10),
  },
});
