import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { PawaPayService } from '../pawapay/pawapay.service';
import { PawaPayRejectedError } from '../pawapay/pawapay.types';

class PredictProviderDto {
  @IsString()
  phoneNumber!: string;
}

class ActiveConfQueryDto {
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'country doit etre un code ISO 3166-1 alpha-3.' })
  country?: string;

  @IsOptional()
  @Matches(/^(DEPOSIT|PAYOUT|REFUND)$/)
  operationType?: string;
}

/**
 * Endpoints de confort pour les interfaces : liste des operateurs actifs,
 * validation de numero. Ils evitent que chaque projet code en dur des
 * operateurs qui changent.
 */
@ApiTags('toolkit')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('toolkit')
export class ToolkitController {
  /** Cache court : la configuration change rarement, mais les statuts de
   *  disponibilite des operateurs, si. */
  private cache = new Map<string, { at: number; value: unknown }>();
  private readonly ttlMs = 60_000;

  constructor(private readonly pawapay: PawaPayService) {}

  @Get('providers')
  @ApiOperation({
    summary: 'Operateurs disponibles',
    description:
      'Retourne les operateurs actifs, leurs logos, devises, bornes de montant ' +
      'et leur disponibilite du moment. A appeler pour construire dynamiquement ' +
      'le selecteur de paiement plutot que de coder les operateurs en dur.',
  })
  async providers(@Query() query: ActiveConfQueryDto) {
    const key = `conf:${query.country ?? '*'}:${query.operationType ?? '*'}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.value;

    const value = await this.pawapay.activeConfiguration(query);
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  @Get('availability')
  @ApiOperation({
    summary: 'Disponibilite des operateurs',
    description:
      'Permet de prevenir le client en amont qu\'un operateur est indisponible, ' +
      'plutot que de le laisser echouer au paiement.',
  })
  availability(@Query('country') country?: string) {
    return this.pawapay.availability(country);
  }

  @Get('balances')
  @ApiOperation({
    summary: 'Soldes du compte marchand',
    description:
      'A consulter avant un reversement : un solde insuffisant fait echouer ' +
      "l'operation cote operateur, apres coup.",
  })
  balances() {
    return this.pawapay.walletBalances();
  }

  @Post('predict-provider')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Valider un numero et deviner l\'operateur',
    description:
      'Normalise le numero au format MSISDN et predit l\'operateur. La ' +
      'prediction n\'est pas fiable a 100 % : la presenter comme selection par ' +
      'defaut, modifiable par le client.',
  })
  async predictProvider(@Body() dto: PredictProviderDto) {
    try {
      return await this.pawapay.predictProvider(dto.phoneNumber);
    } catch (error) {
      if (error instanceof PawaPayRejectedError) {
        throw new BadRequestException({
          code: 'INVALID_PHONE_NUMBER',
          message: error.failureMessage,
        });
      }
      throw error;
    }
  }
}
