import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant, TenantContext } from '../auth/tenant.decorator';
import {
  CreateDepositDto,
  CreatePayoutDto,
  CreateRefundDto,
  ListTransactionsDto,
} from './dto/create-deposit.dto';
import { TransactionsService } from './transactions.service';

@ApiTags('paiements')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller()
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Post('deposits')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Encaisser',
    description:
      "Demande un paiement depuis le portefeuille mobile money du client. " +
      "La reponse est immediate mais non finale : le statut definitif arrive " +
      'par webhook, ou peut etre interroge sur GET /v1/transactions/{id}.',
  })
  createDeposit(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateDepositDto,
  ) {
    return this.transactions.createDeposit(tenant, dto);
  }

  @Post('payouts')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Reverser',
    description:
      'Envoie de l\'argent vers un portefeuille mobile money depuis le solde ' +
      'du compte marchand.',
  })
  createPayout(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreatePayoutDto,
  ) {
    return this.transactions.createPayout(tenant, dto);
  }

  @Post('refunds')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Rembourser',
    description:
      'Rembourse tout ou partie d\'un encaissement deja abouti.',
  })
  createRefund(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateRefundDto,
  ) {
    return this.transactions.createRefund(tenant, dto);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Lister les transactions du projet' })
  list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListTransactionsDto,
  ) {
    return this.transactions.list(tenant, query);
  }

  @Get('transactions/:id')
  @ApiOperation({
    summary: 'Consulter une transaction',
    description:
      'A utiliser comme filet de securite si un webhook n\'a pas ete recu.',
  })
  findOne(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return this.transactions.findOne(tenant, id);
  }
}
