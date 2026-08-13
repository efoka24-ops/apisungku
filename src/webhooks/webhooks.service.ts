import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Transaction } from '@prisma/client';
import { createHmac } from 'node:crypto';

import { PrismaService } from '../common/prisma.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Depose l'evenement dans la file de livraison (outbox). La livraison elle
   * meme est faite par un job separe : une transaction ne doit jamais rester
   * bloquee parce que le serveur du projet client ne repond pas.
   */
  async enqueue(transaction: Transaction): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: transaction.tenantId },
    });
    if (!tenant?.webhookUrl) return;

    const event = `${transaction.type.toLowerCase()}.${transaction.status.toLowerCase()}`;

    await this.prisma.webhookDelivery.create({
      data: {
        tenantId: transaction.tenantId,
        transactionId: transaction.id,
        event,
        payload: {
          event,
          sentAt: new Date().toISOString(),
          data: {
            id: transaction.id,
            type: transaction.type,
            status: transaction.status,
            amount: transaction.amount.toString(),
            currency: transaction.currency,
            country: transaction.country,
            provider: transaction.provider,
            phoneNumber: transaction.phoneNumber,
            reference: transaction.reference,
            metadata: transaction.metadata,
            originalTransactionId: transaction.originalTransactionId,
            providerTransactionId: transaction.providerTransactionId,
            failure: transaction.failureCode
              ? {
                  code: transaction.failureCode,
                  message: transaction.failureMessage,
                }
              : null,
            completedAt: transaction.completedAt?.toISOString() ?? null,
          },
        } as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Livre une entree de la file. La signature HMAC permet au projet client de
   * verifier que l'appel vient bien de nous, et l'horodatage de rejeter les
   * rejeux.
   */
  async deliver(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { tenant: true },
    });
    if (!delivery || delivery.status !== 'PENDING') return;
    if (!delivery.tenant.webhookUrl) {
      await this.markFailed(deliveryId, 'Aucune URL de webhook configuree.');
      return;
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', delivery.tenant.webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    const timeoutMs = this.config.get<number>('webhooks.timeoutMs')!;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(delivery.tenant.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Apisungku-Event': delivery.event,
          'X-Apisungku-Delivery': delivery.id,
          'X-Apisungku-Timestamp': timestamp,
          'X-Apisungku-Signature': `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });

      if (response.ok) {
        await this.prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'DELIVERED',
            deliveredAt: new Date(),
            attempts: { increment: 1 },
            lastError: null,
          },
        });
        return;
      }

      await this.scheduleRetry(delivery.id, delivery.attempts, `HTTP ${response.status}`);
    } catch (error) {
      await this.scheduleRetry(
        delivery.id,
        delivery.attempts,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Backoff exponentiel plafonne a 6 heures : 1 min, 2, 4, 8, 16... */
  private async scheduleRetry(id: string, attempts: number, error: string) {
    const next = attempts + 1;
    const maxAttempts = this.config.get<number>('webhooks.maxAttempts')!;

    if (next >= maxAttempts) {
      await this.markFailed(id, `Abandon apres ${next} tentatives. ${error}`);
      this.logger.error(`Webhook ${id} abandonne : ${error}`);
      return;
    }

    const delayMs = Math.min(60_000 * 2 ** attempts, 6 * 60 * 60 * 1000);
    await this.prisma.webhookDelivery.update({
      where: { id },
      data: {
        attempts: next,
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError: error.slice(0, 500),
      },
    });
  }

  private markFailed(id: string, error: string) {
    return this.prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: 'FAILED',
        attempts: { increment: 1 },
        lastError: error.slice(0, 500),
      },
    });
  }

  /** Rejoue manuellement une livraison abandonnee. */
  async replay(tenantId: string, deliveryId: string) {
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, tenantId },
    });
    if (!delivery) return null;

    return this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date() },
    });
  }
}
