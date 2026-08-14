import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Transaction, TransactionStatus, TransactionType } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../common/prisma.service';
import { TenantContext } from '../auth/tenant.decorator';
import { PawaPayService } from '../pawapay/pawapay.service';
import {
  PawaPayInitiationResponse,
  PawaPayRejectedError,
  PawaPayTransactionData,
  PawaPayUnavailableError,
} from '../pawapay/pawapay.types';
import { WebhooksService } from '../webhooks/webhooks.service';
import {
  CreateDepositDto,
  CreatePayoutDto,
  CreateRefundDto,
  ListTransactionsDto,
} from './dto/create-deposit.dto';

const OPERATION_PATH: Record<TransactionType, 'deposits' | 'payouts' | 'refunds'> = {
  DEPOSIT: 'deposits',
  PAYOUT: 'payouts',
  REFUND: 'refunds',
};

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pawapay: PawaPayService,
    private readonly webhooks: WebhooksService,
  ) {}

  // ─── Creation ────────────────────────────────────────────────────────────

  async createDeposit(tenant: TenantContext, dto: CreateDepositDto) {
    return this.createMoneyMovement(tenant, 'DEPOSIT', dto);
  }

  async createPayout(tenant: TenantContext, dto: CreatePayoutDto) {
    return this.createMoneyMovement(tenant, 'PAYOUT', dto);
  }

  private async createMoneyMovement(
    tenant: TenantContext,
    type: 'DEPOSIT' | 'PAYOUT',
    dto: CreateDepositDto,
  ) {
    const existing = await this.findByReference(tenant.id, dto.reference);
    if (existing) return this.present(existing);

    const { provider, phoneNumber, country } = await this.resolveProvider(
      dto.phoneNumber,
      dto.provider,
    );

    // L'identifiant est genere et persiste AVANT tout appel sortant. C'est ce
    // qui garantit qu'une coupure reseau ne peut pas produire un paiement
    // orphelin : on aura toujours de quoi interroger pawaPay.
    const id = randomUUID();
    const transaction = await this.prisma.transaction.create({
      data: {
        id,
        tenantId: tenant.id,
        type,
        status: 'PENDING',
        amount: new Prisma.Decimal(dto.amount),
        currency: dto.currency,
        country,
        provider,
        phoneNumber,
        reference: dto.reference ?? null,
        description: dto.description ?? null,
        customerMessage: dto.customerMessage ?? null,
        metadata: (dto.metadata ?? undefined) as Prisma.InputJsonValue,
      },
    });

    const party = {
      type: 'MMO' as const,
      accountDetails: { phoneNumber, provider },
    };
    // clientReferenceId remonte la reference du projet jusqu'au tableau de bord
    // pawaPay : indispensable pour rapprocher un litige sans passer par nos
    // propres journaux.
    const commun = {
      amount: dto.amount,
      currency: dto.currency,
      ...(dto.reference ? { clientReferenceId: dto.reference } : {}),
      ...(dto.customerMessage ? { customerMessage: dto.customerMessage } : {}),
    };

    const payload =
      type === 'DEPOSIT'
        ? { depositId: id, ...commun, payer: party }
        : { payoutId: id, ...commun, recipient: party };

    const updated = await this.dispatchInitiation(transaction, () =>
      type === 'DEPOSIT'
        ? this.pawapay.initiateDeposit(payload)
        : this.pawapay.initiatePayout(payload),
    );

    return this.present(updated);
  }

  async createRefund(tenant: TenantContext, dto: CreateRefundDto) {
    const existing = await this.findByReference(tenant.id, dto.reference);
    if (existing) return this.present(existing);

    const deposit = await this.prisma.transaction.findFirst({
      where: { id: dto.depositId, tenantId: tenant.id, type: 'DEPOSIT' },
    });
    if (!deposit) {
      throw new NotFoundException(`Aucun depot ${dto.depositId} sur ce projet.`);
    }
    if (deposit.status !== 'COMPLETED') {
      throw new BadRequestException(
        `Le depot ${dto.depositId} est au statut ${deposit.status}. ` +
          'Seul un depot COMPLETED peut etre rembourse.',
      );
    }

    const id = randomUUID();
    const transaction = await this.prisma.transaction.create({
      data: {
        id,
        tenantId: tenant.id,
        type: 'REFUND',
        status: 'PENDING',
        amount: dto.amount ? new Prisma.Decimal(dto.amount) : deposit.amount,
        currency: deposit.currency,
        country: deposit.country,
        provider: deposit.provider,
        phoneNumber: deposit.phoneNumber,
        reference: dto.reference ?? null,
        originalTransactionId: deposit.id,
        metadata: (dto.metadata ?? undefined) as Prisma.InputJsonValue,
      },
    });

    const updated = await this.dispatchInitiation(transaction, () =>
      this.pawapay.initiateRefund({
        refundId: id,
        depositId: deposit.id,
        ...(dto.amount ? { amount: dto.amount } : {}),
      }),
    );

    return this.present(updated);
  }

  /**
   * Envoie l'initiation et traduit toutes les issues possibles en statut
   * interne. La regle qui structure ce bloc : on ne marque FAILED que sur
   * preuve explicite d'echec, jamais sur une simple absence de reponse.
   */
  private async dispatchInitiation(
    transaction: Transaction,
    call: () => Promise<PawaPayInitiationResponse>,
  ): Promise<Transaction> {
    try {
      const response = await call();

      switch (response.status) {
        case 'ACCEPTED':
          return this.applyStatus(transaction, 'PROCESSING');

        case 'REJECTED':
        case 'FAILED':
          return this.applyStatus(transaction, 'FAILED', {
            failureCode: response.failureReason?.failureCode ?? 'REJECTED',
            failureMessage:
              response.failureReason?.failureMessage ??
              "pawaPay a refuse l'operation sans preciser de motif.",
          });

        case 'DUPLICATE_IGNORED':
          // Impossible en theorie : l'identifiant vient d'etre genere. Si cela
          // se produit, c'est une anomalie qui merite un regard humain.
          this.logger.error(
            `DUPLICATE_IGNORED inattendu sur ${transaction.id}. Collision d'UUID ou rejeu.`,
          );
          return this.applyStatus(transaction, 'NEEDS_ATTENTION', {
            failureCode: 'DUPLICATE_IGNORED',
            failureMessage: 'Identifiant deja utilise chez pawaPay.',
          });

        default:
          return this.applyStatus(transaction, 'NEEDS_ATTENTION', {
            failureCode: 'UNEXPECTED_STATUS',
            failureMessage: `Statut inconnu renvoye par pawaPay : ${String(response.status)}.`,
          });
      }
    } catch (error) {
      if (error instanceof PawaPayRejectedError) {
        // Refus explicite et documente : l'echec est certain.
        return this.applyStatus(transaction, 'FAILED', {
          failureCode: error.failureCode,
          failureMessage: error.failureMessage,
        });
      }

      if (error instanceof PawaPayUnavailableError) {
        this.logger.warn(
          `Issue indeterminee sur ${transaction.id} : ${error.message}. Verification du statut.`,
        );
        return this.verifyAfterUncertainty(transaction);
      }

      throw error;
    }
  }

  /**
   * Apres une issue indeterminee, on interroge pawaPay. Seul un NOT_FOUND
   * autorise a conclure a l'echec ; sinon la transaction reste PENDING et
   * c'est le job de reconciliation qui tranchera.
   */
  private async verifyAfterUncertainty(
    transaction: Transaction,
  ): Promise<Transaction> {
    try {
      const check = await this.pawapay.checkStatus(
        OPERATION_PATH[transaction.type],
        transaction.id,
      );

      if (check.status === 'NOT_FOUND') {
        return this.applyStatus(transaction, 'FAILED', {
          failureCode: 'NOT_REACHED',
          failureMessage:
            "L'operation n'a jamais atteint pawaPay. Aucun mouvement de fonds.",
        });
      }

      if (check.data) return this.applyProviderState(transaction, check.data);
    } catch {
      // pawaPay reste injoignable : on ne conclut rien.
    }

    return transaction;
  }

  // ─── Mise a jour depuis pawaPay ──────────────────────────────────────────

  /**
   * Applique l'etat renvoye par pawaPay (callback ou verification) a une
   * transaction. Point d'entree unique pour toute transition de statut venant
   * de l'exterieur.
   */
  async applyProviderState(
    transaction: Transaction,
    data: PawaPayTransactionData,
  ): Promise<Transaction> {
    const status = mapProviderStatus(data.status);

    return this.applyStatus(transaction, status, {
      failureCode: data.failureReason?.failureCode,
      failureMessage: data.failureReason?.failureMessage,
      providerTransactionId: data.providerTransactionId,
      country: data.country,
    });
  }

  private async applyStatus(
    transaction: Transaction,
    status: TransactionStatus,
    extra: {
      failureCode?: string;
      failureMessage?: string;
      providerTransactionId?: string;
      country?: string;
    } = {},
  ): Promise<Transaction> {
    // Un statut final ne change plus : les callbacks pawaPay peuvent arriver
    // en double ou dans le desordre.
    if (isFinal(transaction.status) && transaction.status !== status) {
      this.logger.warn(
        `Transition ignoree sur ${transaction.id} : ${transaction.status} -> ${status}.`,
      );
      return transaction;
    }
    if (transaction.status === status && status !== 'PENDING') {
      return transaction;
    }

    const updated = await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status,
        failureCode: extra.failureCode ?? transaction.failureCode,
        failureMessage: extra.failureMessage ?? transaction.failureMessage,
        providerTransactionId:
          extra.providerTransactionId ?? transaction.providerTransactionId,
        country: extra.country ?? transaction.country,
        completedAt: isFinal(status) ? new Date() : null,
      },
    });

    if (isFinal(status) || status === 'NEEDS_ATTENTION') {
      await this.webhooks.enqueue(updated);
    }

    return updated;
  }

  // ─── Lecture ─────────────────────────────────────────────────────────────

  async findOne(tenant: TenantContext, id: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!transaction) {
      throw new NotFoundException(`Transaction ${id} introuvable.`);
    }
    return this.present(transaction);
  }

  async list(tenant: TenantContext, query: ListTransactionsDto) {
    const limit = Math.min(parseInt(query.limit ?? '50', 10) || 50, 200);
    const rows = await this.prisma.transaction.findMany({
      where: {
        tenantId: tenant.id,
        ...(query.type ? { type: query.type as TransactionType } : {}),
        ...(query.status ? { status: query.status as TransactionStatus } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: page.map((row) => this.present(row)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /** Recherche interne, sans filtre de projet : reservee aux callbacks. */
  findById(id: string) {
    return this.prisma.transaction.findUnique({ where: { id } });
  }

  private async findByReference(tenantId: string, reference?: string) {
    if (!reference) return null;
    return this.prisma.transaction.findFirst({
      where: { tenantId, reference },
    });
  }

  private async resolveProvider(phoneNumber: string, provider?: string) {
    try {
      const prediction = await this.pawapay.predictProvider(phoneNumber);
      return {
        // Un operateur fourni explicitement l'emporte sur la prediction, qui
        // n'est pas fiable a 100 %.
        provider: provider ?? prediction.provider,
        phoneNumber: prediction.phoneNumber,
        country: prediction.country,
      };
    } catch (error) {
      if (provider) {
        // La prediction n'est qu'un confort : si l'appelant sait deja quel
        // operateur viser, son indisponibilite ne doit pas bloquer.
        this.logger.warn(
          `predict-provider indisponible, poursuite avec ${provider}.`,
        );
        return { provider, phoneNumber, country: undefined };
      }
      if (error instanceof PawaPayRejectedError) {
        throw new BadRequestException({
          code: 'INVALID_PHONE_NUMBER',
          message: `Numero invalide : ${error.failureMessage}`,
        });
      }
      throw error;
    }
  }

  /** Forme publique d'une transaction, stable pour les projets clients. */
  present(transaction: Transaction) {
    return {
      id: transaction.id,
      type: transaction.type,
      status: transaction.status,
      amount: transaction.amount.toString(),
      currency: transaction.currency,
      country: transaction.country,
      provider: transaction.provider,
      phoneNumber: transaction.phoneNumber,
      reference: transaction.reference,
      description: transaction.description,
      customerMessage: transaction.customerMessage,
      metadata: transaction.metadata,
      originalTransactionId: transaction.originalTransactionId,
      providerTransactionId: transaction.providerTransactionId,
      failure: transaction.failureCode
        ? { code: transaction.failureCode, message: transaction.failureMessage }
        : null,
      createdAt: transaction.createdAt.toISOString(),
      completedAt: transaction.completedAt?.toISOString() ?? null,
    };
  }
}

export function isFinal(status: TransactionStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

export function mapProviderStatus(status: string): TransactionStatus {
  switch (status) {
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'ACCEPTED':
    case 'ENQUEUED':
    case 'SUBMITTED':
    case 'PROCESSING':
      return 'PROCESSING';
    default:
      // Statut non reconnu : surtout ne pas deviner.
      return 'NEEDS_ATTENTION';
  }
}
