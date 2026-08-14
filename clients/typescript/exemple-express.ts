/**
 * Exemple d'integration complete avec Express, transposable a NestJS,
 * Fastify ou Next.js.
 */
import express from 'express';

import { Apisungku, verifierWebhook } from './apisungku';

const paiements = new Apisungku({
  baseUrl: process.env.PAYMENTS_API_URL!, // https://apisungku.trugroup.cm/v1
  apiKey: process.env.PAYMENTS_API_KEY!,
});

const app = express();

// ─── 1. Operateurs a afficher dans le selecteur ─────────────────────────────
// Appele par le frontend. N'expose que les operateurs operationnels : le jour
// ou un operateur revient, il apparait sans redeploiement.
app.get('/api/paiements/operateurs', async (_req, res) => {
  res.json(await paiements.operateurs('CMR'));
});

// ─── 2. Lancer un encaissement ──────────────────────────────────────────────
app.post('/api/courses/:id/payer', express.json(), async (req, res) => {
  const course = await Course.findById(req.params.id);

  try {
    const paiement = await paiements.encaisser({
      amount: String(course.montant), // entier : le XAF n'a pas de decimales
      currency: 'XAF',
      phoneNumber: req.body.telephone, // 237XXXXXXXXX
      reference: `course-${course.id}`, // unique : protege du double clic
      customerMessage: 'Course KoliGo', // 4 a 22 caracteres
      metadata: { courseId: course.id },
    });

    await course.update({
      paiementId: paiement.id,
      statut: 'PAIEMENT_EN_ATTENTE',
    });

    // On ne demarre rien ici : le paiement n'est pas encore autorise.
    res.json({ paiementId: paiement.id, statut: paiement.status });
  } catch (erreur: any) {
    if (erreur.code === 'NETWORK_ERROR') {
      // Issue indeterminee : surtout ne pas rejouer aveuglement. La reference
      // etant idempotente, une nouvelle tentative renverra la transaction
      // existante plutot que d'en creer une seconde.
      await course.update({ statut: 'PAIEMENT_INCERTAIN' });
      return res.status(503).json({ message: 'Reessayez dans un instant.' });
    }
    res.status(400).json({ message: erreur.message });
  }
});

// ─── 3. Recevoir le resultat ────────────────────────────────────────────────
// express.raw est indispensable : la signature porte sur le corps brut.
app.post(
  '/api/paiements/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let evenement;
    try {
      evenement = verifierWebhook({
        corpsBrut: req.body.toString('utf8'),
        signature: req.header('X-Apisungku-Signature'),
        timestamp: req.header('X-Apisungku-Timestamp'),
        secret: process.env.PAYMENTS_WEBHOOK_SECRET!,
      });
    } catch (erreur: any) {
      console.warn('Webhook rejete :', erreur.message);
      return res.sendStatus(401);
    }

    const { data } = evenement;

    // Toute reponse non-2xx declenche un reessai : repondre vite, traiter
    // ensuite si le traitement est long.
    switch (`${data.type}:${data.status}`) {
      case 'DEPOSIT:COMPLETED':
        await demarrerLaCourse(data.reference!);
        break;

      case 'DEPOSIT:FAILED':
        await annulerLaCourse(data.reference!, data.failure);
        break;

      case 'PAYOUT:COMPLETED':
        await marquerTransporteurPaye(data.reference!);
        break;

      default:
        if (data.status === 'NEEDS_ATTENTION') {
          // Issue indeterminee : l'argent a peut-etre bouge. Escalade humaine,
          // jamais de remboursement automatique.
          await alerterSupport(data);
        }
    }

    res.sendStatus(200);
  },
);

// ─── 4. Reverser au transporteur ────────────────────────────────────────────
// A appeler une fois la livraison confirmee, et seulement si l'encaissement
// correspondant est COMPLETED : sinon on paie avec de l'argent non recu.
async function reverserAuTransporteur(course: any) {
  const encaissement = await paiements.consulter(course.paiementId);
  if (encaissement.status !== 'COMPLETED') return;

  await paiements.reverser({
    amount: String(course.montant - course.commission),
    currency: 'XAF',
    phoneNumber: course.transporteur.telephone,
    reference: `reversement-${course.id}`, // distincte de celle du depot
    customerMessage: 'Paiement KoliGo',
    metadata: { courseId: course.id },
  });
}

declare const Course: any;
declare function demarrerLaCourse(reference: string): Promise<void>;
declare function annulerLaCourse(reference: string, echec: unknown): Promise<void>;
declare function marquerTransporteurPaye(reference: string): Promise<void>;
declare function alerterSupport(donnees: unknown): Promise<void>;

export { app, reverserAuTransporteur };
