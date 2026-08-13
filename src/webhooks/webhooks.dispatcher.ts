import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../common/prisma.service';
import { WebhooksService } from './webhooks.service';

/**
 * Vide la file des webhooks sortants. Un job en base plutot qu'un envoi en
 * ligne : un redemarrage du service ne doit pas faire perdre d'evenement.
 */
@Injectable()
export class WebhooksDispatcher {
  private readonly logger = new Logger(WebhooksDispatcher.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async dispatch() {
    if (this.running) return;
    this.running = true;

    try {
      const due = await this.prisma.webhookDelivery.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        take: 50,
      });

      for (const delivery of due) {
        await this.webhooks.deliver(delivery.id);
      }

      if (due.length > 0) {
        this.logger.debug(`${due.length} webhook(s) traite(s).`);
      }
    } catch (error) {
      this.logger.error('Echec du cycle de livraison des webhooks.', error);
    } finally {
      this.running = false;
    }
  }
}
