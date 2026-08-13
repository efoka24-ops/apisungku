import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';

import { TransactionsService } from '../transactions/transactions.service';
import { PawaPayService } from '../pawapay/pawapay.service';

type Operation = 'deposits' | 'payouts' | 'refunds';

const ID_FIELD: Record<Operation, string> = {
  deposits: 'depositId',
  payouts: 'payoutId',
  refunds: 'refundId',
};

/**
 * Unique URL de callback declaree chez pawaPay, pour tous les projets a la
 * fois. C'est ce qui rend l'ajout d'un nouveau projet gratuit : rien a
 * reconfigurer cote operateur.
 */
@ApiExcludeController()
@Controller('callbacks')
export class CallbacksController {
  private readonly logger = new Logger(CallbacksController.name);

  constructor(
    private readonly transactions: TransactionsService,
    private readonly pawapay: PawaPayService,
    private readonly config: ConfigService,
  ) {}

  @Post('pawapay/:operation')
  @HttpCode(200)
  async handle(
    @Param('operation') operation: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-callback-secret') secret?: string,
  ) {
    this.assertSecret(secret);

    if (!isOperation(operation)) {
      this.logger.warn(`Callback recu sur une operation inconnue : ${operation}`);
      return { received: true };
    }

    const id = body[ID_FIELD[operation]];
    if (typeof id !== 'string') {
      this.logger.warn(`Callback ${operation} sans ${ID_FIELD[operation]}.`);
      return { received: true };
    }

    const transaction = await this.transactions.findById(id);
    if (!transaction) {
      // Peut arriver si le callback devance l'ecriture de notre reponse
      // d'initiation. La reconciliation rattrapera.
      this.logger.warn(`Callback pour une transaction inconnue : ${id}`);
      return { received: true };
    }

    // Le contenu du callback n'est pas pris pour argent comptant : on demande
    // a pawaPay l'etat reel avant de toucher au statut. Cela neutralise aussi
    // bien un callback falsifie qu'un callback arrive dans le desordre.
    try {
      const check = await this.pawapay.checkStatus(operation, id);
      if (check.status === 'FOUND' && check.data) {
        await this.transactions.applyProviderState(transaction, check.data);
      }
    } catch (error) {
      // On repond quand meme 200 : pawaPay ne doit pas rejouer indefiniment,
      // et la reconciliation reprendra la transaction.
      this.logger.error(
        `Verification impossible pour ${id}, laissee a la reconciliation.`,
        error,
      );
    }

    return { received: true };
  }

  private assertSecret(presented?: string) {
    const expected = this.config.get<string>('pawapay.callbackSecret');
    if (!expected) return; // Verification desactivee (developpement).
    if (presented !== expected) {
      throw new UnauthorizedException('Callback non authentifie.');
    }
  }
}

function isOperation(value: string): value is Operation {
  return value === 'deposits' || value === 'payouts' || value === 'refunds';
}
