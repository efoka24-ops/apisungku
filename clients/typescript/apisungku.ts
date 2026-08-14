/**
 * Client apisungku — a deposer tel quel dans un projet (KoliGo, Sungku, ...).
 *
 * Aucune dependance : uniquement fetch et node:crypto.
 *
 *   import { Apisungku, verifierWebhook } from './apisungku';
 *
 *   const paiements = new Apisungku({
 *     baseUrl: process.env.PAYMENTS_API_URL!,
 *     apiKey: process.env.PAYMENTS_API_KEY!,
 *   });
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export type TypeTransaction = 'DEPOSIT' | 'PAYOUT' | 'REFUND';

/**
 * PENDING / PROCESSING ne sont pas finaux.
 * NEEDS_ATTENTION signale une issue indeterminee : ne jamais la traiter comme
 * un echec, l'argent a peut-etre bouge.
 */
export type StatutTransaction =
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'NEEDS_ATTENTION';

export interface Transaction {
  id: string;
  type: TypeTransaction;
  status: StatutTransaction;
  amount: string;
  currency: string;
  country: string | null;
  provider: string | null;
  phoneNumber: string | null;
  reference: string | null;
  description: string | null;
  customerMessage: string | null;
  metadata: unknown;
  originalTransactionId: string | null;
  providerTransactionId: string | null;
  failure: { code: string; message: string | null } | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DemandePaiement {
  /** Montant entier en chaine pour le XAF : cette devise n'a pas de decimales. */
  amount: string;
  currency: string;
  /** Format MSISDN : 237XXXXXXXXX, sans + ni espaces. */
  phoneNumber: string;
  /** Optionnel : deduit du numero s'il est absent. */
  provider?: string;
  /**
   * Votre propre reference, unique par projet. La reutiliser renvoie la
   * transaction existante au lieu d'en creer une seconde : c'est votre
   * protection contre les doubles soumissions de formulaire.
   */
  reference?: string;
  description?: string;
  /** Affiche au payeur sur l'invite PIN. Entre 4 et 22 caracteres. */
  customerMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface Operateur {
  provider: string;
  displayName: string;
  logo?: string;
  currency: string;
  status: string;
  minAmount: string;
  maxAmount: string;
  decimalsInAmount: string;
}

export class ErreurApisungku extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'ErreurApisungku';
  }
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface OptionsClient {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export class Apisungku {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: OptionsClient) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** Encaisser depuis le portefeuille mobile money d'un client. */
  encaisser(demande: DemandePaiement): Promise<Transaction> {
    return this.appel('POST', '/deposits', demande);
  }

  /** Reverser vers un portefeuille mobile money. */
  reverser(demande: DemandePaiement): Promise<Transaction> {
    return this.appel('POST', '/payouts', demande);
  }

  /** Rembourser tout ou partie d'un encaissement abouti. */
  rembourser(params: {
    depositId: string;
    amount?: string;
    reference?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Transaction> {
    return this.appel('POST', '/refunds', params);
  }

  /**
   * Consulter une transaction. A utiliser comme filet de securite si un
   * webhook n'a pas ete recu, jamais en boucle serree.
   */
  consulter(id: string): Promise<Transaction> {
    return this.appel('GET', `/transactions/${encodeURIComponent(id)}`);
  }

  lister(filtres: {
    type?: TypeTransaction;
    status?: StatutTransaction;
    cursor?: string;
    limit?: number;
  } = {}): Promise<{ data: Transaction[]; nextCursor: string | null }> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filtres)) {
      if (v !== undefined) q.set(k, String(v));
    }
    const suffixe = q.toString() ? `?${q}` : '';
    return this.appel('GET', `/transactions${suffixe}`);
  }

  /** Valider un numero et deviner son operateur. */
  validerNumero(phoneNumber: string): Promise<{
    country: string;
    provider: string;
    phoneNumber: string;
  }> {
    return this.appel('POST', '/toolkit/predict-provider', { phoneNumber });
  }

  /**
   * Operateurs a proposer au client, mis a plat. Ne retient que ceux qui sont
   * operationnels : afficher un operateur en panne ne produit que des
   * paiements echoues.
   */
  async operateurs(country = 'CMR'): Promise<Operateur[]> {
    const conf = await this.appel<any>(
      'GET',
      `/toolkit/providers?country=${encodeURIComponent(country)}&operationType=DEPOSIT`,
    );

    const resultat: Operateur[] = [];
    for (const pays of conf.countries ?? []) {
      for (const p of pays.providers ?? []) {
        for (const c of p.currencies ?? []) {
          const op = c.operationTypes?.DEPOSIT;
          if (!op || op.status !== 'OPERATIONAL') continue;
          resultat.push({
            provider: p.provider,
            displayName: p.displayName ?? p.provider,
            logo: p.logo,
            currency: c.currency,
            status: op.status,
            minAmount: op.minAmount,
            maxAmount: op.maxAmount,
            decimalsInAmount: op.decimalsInAmount,
          });
        }
      }
    }
    return resultat;
  }

  /** Verifier que la cle fonctionne et connaitre sa configuration. */
  moi(): Promise<{
    id: string;
    name: string;
    slug: string;
    webhookUrl: string | null;
    environnement: 'sandbox' | 'production';
    transactions: number;
  }> {
    return this.appel('GET', '/me');
  }

  /** Changer l'URL de reception des webhooks. */
  definirWebhook(webhookUrl: string): Promise<{ webhookUrl: string }> {
    return this.appel('PATCH', '/me', { webhookUrl });
  }

  private async appel<T>(
    method: string,
    chemin: string,
    corps?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let reponse: Response;
    try {
      reponse = await fetch(`${this.baseUrl}${chemin}`, {
        method,
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: corps === undefined ? undefined : JSON.stringify(corps),
        signal: controller.signal,
      });
    } catch (cause) {
      // Issue indeterminee : la demande a pu aboutir malgre l'absence de
      // reponse. Ne jamais conclure a un echec ici ; consulter la transaction
      // par sa reference avant de reessayer.
      throw new ErreurApisungku(
        'NETWORK_ERROR',
        `Aucune reponse de la passerelle sur ${method} ${chemin}.`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const texte = await reponse.text();
    const donnees = texte ? JSON.parse(texte) : undefined;

    if (!reponse.ok) {
      const erreur = donnees?.error ?? {};
      throw new ErreurApisungku(
        erreur.code ?? 'UNKNOWN',
        erreur.message ?? `HTTP ${reponse.status}`,
        reponse.status,
      );
    }

    return donnees as T;
  }
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

export interface EvenementWebhook {
  event: string;
  sentAt: string;
  data: Transaction;
}

/**
 * Verifie l'authenticite d'un webhook.
 *
 * A appeler sur le corps BRUT, avant tout parsing : re-serialiser le JSON
 * modifie les espaces et invalide la signature.
 *
 * Sans cette verification, n'importe qui connaissant votre URL peut vous
 * annoncer un paiement reussi qui n'a jamais eu lieu.
 */
export function verifierWebhook(params: {
  corpsBrut: string;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  toleranceSecondes?: number;
}): EvenementWebhook {
  const { corpsBrut, signature, timestamp, secret } = params;
  const tolerance = params.toleranceSecondes ?? 300;

  if (!signature || !timestamp) {
    throw new Error('Webhook non signe : en-tetes manquants.');
  }

  // Fenetre temporelle : sans elle, une signature valide capturee une fois
  // reste rejouable indefiniment.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > tolerance) {
    throw new Error('Webhook hors de la fenetre temporelle acceptee.');
  }

  const attendu =
    'sha256=' +
    createHmac('sha256', secret).update(`${timestamp}.${corpsBrut}`).digest('hex');

  const a = Buffer.from(attendu);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Signature de webhook invalide.');
  }

  return JSON.parse(corpsBrut) as EvenementWebhook;
}

/** Un statut dont on peut conclure sans risque. */
export function estFinal(statut: StatutTransaction): boolean {
  return statut === 'COMPLETED' || statut === 'FAILED';
}
