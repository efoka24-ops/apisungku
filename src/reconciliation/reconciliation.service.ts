import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TransactionType } from '@prisma/client';

import { PrismaService } from '../common/prisma.service';
import { PawaPayService } from '../pawapay/pawapay.service';
import { TransactionsService } from '../transactions/transactions.service';

const OPERATION_PATH: Record<TransactionType, 'deposits' | 'payouts' | 'refunds'> = {
  DEPOSIT: 'deposits',
  PAYOUT: 'payouts',
  REFUND: 'refunds',
};

/**
 * Filet de securite du service. Meme avec des callbacks correctement
 * configures, une panne reseau ou un redemarrage peut faire perdre un
 * evenement. Ce cycle garantit qu'aucune transaction ne reste indefiniment
 * en attente, et donc qu'aucun client ne reste sans reponse.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pawapay: PawaPayService,
    private readonly transactions: TransactionsService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcile() {
    if (this.running) return;
    this.running = true;

    try {
      const afterMinutes = this.config.get<number>('reconciliation.afterMinutes')!;
      const maxAttempts = this.config.get<number>('reconciliation.maxAttempts')!;
      const threshold = new Date(Date.now() - afterMinutes * 60_000);

      const pending = await this.prisma.transaction.findMany({
        where: {
          status: { in: ['PENDING', 'PROCESSING'] },
          createdAt: { lte: threshold },
          reconcileAttempts: { lt: maxAttempts },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });

      if (pending.length === 0) return;
      this.logger.log(`Reconciliation de ${pending.length} transaction(s).`);

      for (const transaction of pending) {
        try {
          const check = await this.pawapay.checkStatus(
            OPERATION_PATH[transaction.type],
            transaction.id,
          );

          if (check.status === 'NOT_FOUND') {
            // Seul cas ou l'echec est certain : l'operation n'a jamais
            // atteint pawaPay, donc aucun mouvement de fonds n'a eu lieu.
            await this.transactions.applyProviderState(transaction, {
              status: 'FAILED',
              failureReason: {
                failureCode: 'NOT_REACHED',
                failureMessage:
                  "L'operation n'a jamais atteint pawaPay. Aucun mouvement de fonds.",
              },
            });
          } else if (check.data) {
            await this.transactions.applyProviderState(transaction, check.data);
          }
        } catch (error) {
          this.logger.warn(
            `Verification impossible pour ${transaction.id}, report au cycle suivant.`,
          );
        } finally {
          await this.prisma.transaction.update({
            where: { id: transaction.id },
            data: {
              reconcileAttempts: { increment: 1 },
              lastReconciledAt: new Date(),
            },
          });
        }
      }
    } catch (error) {
      this.logger.error('Echec du cycle de reconciliation.', error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Passe en NEEDS_ATTENTION les transactions que la reconciliation n'a jamais
   * pu trancher. Elles demandent un regard humain : ne jamais les considerer
   * comme echouees automatiquement.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async escalateStuck() {
    const maxAttempts = this.config.get<number>('reconciliation.maxAttempts')!;

    const stuck = await this.prisma.transaction.updateMany({
      where: {
        status: { in: ['PENDING', 'PROCESSING'] },
        reconcileAttempts: { gte: maxAttempts },
      },
      data: {
        status: 'NEEDS_ATTENTION',
        failureCode: 'UNRESOLVED',
        failureMessage:
          'Statut indetermine apres epuisement des verifications. Verification manuelle requise.',
      },
    });

    if (stuck.count > 0) {
      this.logger.error(
        `${stuck.count} transaction(s) passee(s) en NEEDS_ATTENTION. Verification manuelle requise.`,
      );
    }
  }
}
