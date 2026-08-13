import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Montant decimal positif, en chaine, pour ne jamais passer par un float. */
export const AMOUNT_PATTERN = /^\d+(\.\d{1,4})?$/;

export class CreateDepositDto {
  @ApiProperty({ example: '5000', description: 'Montant a encaisser.' })
  @Matches(AMOUNT_PATTERN, {
    message:
      'amount doit etre un nombre positif transmis en chaine, ex. "5000" ou "12.50".',
  })
  amount!: string;

  @ApiProperty({ example: 'XAF' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency doit etre un code ISO 4217.' })
  currency!: string;

  @ApiProperty({
    example: '237670000000',
    description:
      'Numero au format MSISDN, indicatif pays compris, sans + ni espaces. ' +
      'Utiliser /v1/toolkit/predict-provider pour le normaliser.',
  })
  @Matches(/^\d{6,15}$/, {
    message: 'phoneNumber doit contenir de 6 a 15 chiffres, indicatif compris.',
  })
  phoneNumber!: string;

  @ApiPropertyOptional({
    example: 'MTN_MOMO_CMR',
    description:
      'Operateur. Si absent, il est deduit du numero via predict-provider.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  provider?: string;

  @ApiPropertyOptional({
    description:
      'Reference propre a votre projet (numero de commande, id de cagnotte). ' +
      'Unique par projet : la reutiliser renvoie la transaction existante.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  reference?: string;

  @ApiPropertyOptional({ description: 'Libelle interne, non transmis au payeur.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({
    description: 'Donnees libres restituees telles quelles dans les webhooks.',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CreatePayoutDto extends CreateDepositDto {}

export class CreateRefundDto {
  @ApiProperty({
    description: 'Identifiant du depot a rembourser, tel que renvoye a la creation.',
  })
  @IsString()
  depositId!: string;

  @ApiPropertyOptional({
    description:
      'Montant a rembourser. Omis, le depot est rembourse integralement.',
  })
  @IsOptional()
  @Matches(AMOUNT_PATTERN, {
    message: 'amount doit etre un nombre positif transmis en chaine.',
  })
  amount?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ListTransactionsDto {
  @ApiPropertyOptional({ enum: ['DEPOSIT', 'PAYOUT', 'REFUND'] })
  @IsOptional()
  @IsIn(['DEPOSIT', 'PAYOUT', 'REFUND'])
  type?: 'DEPOSIT' | 'PAYOUT' | 'REFUND';

  @ApiPropertyOptional({
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'NEEDS_ATTENTION'],
  })
  @IsOptional()
  @IsIn(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'NEEDS_ATTENTION'])
  status?: string;

  @ApiPropertyOptional({ description: 'Curseur : id de la derniere ligne recue.' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;
}
