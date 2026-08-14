import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Patch,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { generateApiKey } from '../auth/api-key.util';
import { CurrentTenant, TenantContext } from '../auth/tenant.decorator';
import { PrismaService } from '../common/prisma.service';

class CreateProjectDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @Matches(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, {
    message:
      'slug doit etre en minuscules, chiffres et tirets, entre 3 et 50 caracteres.',
  })
  slug!: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  webhookUrl?: string;
}

class UpdateProjectDto {
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  webhookUrl?: string;
}

/**
 * Enrolement des projets clients par HTTP. Ajouter un projet ne demande donc
 * ni acces SSH ni intervention sur le conteneur : un appel suffit.
 */
@ApiTags('projets')
@Controller()
export class ProjectsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Post('projects')
  @HttpCode(201)
  @ApiExcludeEndpoint()
  async create(
    @Body() dto: CreateProjectDto,
    @Headers('x-admin-key') adminKey?: string,
  ) {
    this.assertAdmin(adminKey);

    const existing = await this.prisma.tenant.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new BadRequestException({
        code: 'SLUG_ALREADY_USED',
        message:
          `Le projet '${dto.slug}' existe deja. Utilisez POST /v1/projects/${dto.slug}/keys ` +
          'pour lui ajouter une cle.',
      });
    }

    const salt = this.config.get<string>('apiKeySalt')!;
    const env = this.config
      .get<string>('pawapay.baseUrl')!
      .includes('sandbox')
      ? 'test'
      : 'live';
    const key = generateApiKey(salt, env);
    const webhookSecret = randomBytes(32).toString('hex');

    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        webhookUrl: dto.webhookUrl ?? null,
        webhookSecret,
        apiKeys: {
          create: { prefix: key.prefix, hash: key.hash, label: 'cle initiale' },
        },
      },
    });

    // Seule reponse ou la cle et le secret apparaissent en clair : seul le
    // hachage de la cle est conserve, et le secret n'est plus jamais renvoye.
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      webhookUrl: tenant.webhookUrl,
      apiKey: key.plaintext,
      webhookSecret,
      avertissement:
        'Conservez apiKey et webhookSecret maintenant : ils ne seront plus jamais affiches.',
    };
  }

  @Post('projects/:slug/keys')
  @HttpCode(201)
  @ApiExcludeEndpoint()
  async addKey(
    @Body() body: { slug?: string },
    @Headers('x-admin-key') adminKey?: string,
  ) {
    this.assertAdmin(adminKey);

    const slug = body.slug;
    if (!slug) throw new BadRequestException('slug requis.');

    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) throw new BadRequestException(`Projet '${slug}' introuvable.`);

    const salt = this.config.get<string>('apiKeySalt')!;
    const env = this.config.get<string>('pawapay.baseUrl')!.includes('sandbox')
      ? 'test'
      : 'live';
    const key = generateApiKey(salt, env);

    await this.prisma.apiKey.create({
      data: {
        tenantId: tenant.id,
        prefix: key.prefix,
        hash: key.hash,
        label: 'cle de rotation',
      },
    });

    // L'ancienne cle reste valide : c'est ce qui permet une rotation sans
    // interruption. La revoquer est une action distincte et volontaire.
    return {
      slug: tenant.slug,
      apiKey: key.plaintext,
      avertissement:
        'Les cles precedentes restent actives. Revoquez-les une fois la bascule faite.',
    };
  }

  @Get('me')
  @ApiSecurity('apiKey')
  @UseGuards(ApiKeyGuard)
  @ApiOperation({
    summary: 'Identite du projet appelant',
    description:
      'Permet a un projet de verifier que sa cle est valide et de connaitre sa ' +
      'configuration, sans exposer les autres projets.',
  })
  async me(@CurrentTenant() tenant: TenantContext) {
    const [transactions, record] = await Promise.all([
      this.prisma.transaction.count({ where: { tenantId: tenant.id } }),
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } }),
    ]);

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      webhookUrl: record.webhookUrl,
      environnement: this.config
        .get<string>('pawapay.baseUrl')!
        .includes('sandbox')
        ? 'sandbox'
        : 'production',
      callbackUrl: `${this.config.get<string>('publicUrl')}/v1/callbacks/pawapay`,
      transactions,
    };
  }

  @Patch('me')
  @ApiSecurity('apiKey')
  @UseGuards(ApiKeyGuard)
  @ApiOperation({
    summary: 'Modifier sa propre URL de webhook',
    description:
      'Un projet gere son URL de reception sans intervention sur le serveur.',
  })
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: UpdateProjectDto,
  ) {
    const updated = await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: { webhookUrl: dto.webhookUrl ?? null },
    });

    return { slug: updated.slug, webhookUrl: updated.webhookUrl };
  }

  /**
   * Sans cle d'administration configuree, l'enrolement est ferme plutot
   * qu'ouvert : un endpoint libre laisserait n'importe qui creer un projet et
   * declencher des mouvements de fonds sur le compte marchand.
   */
  private assertAdmin(presented?: string) {
    const expected = this.config.get<string>('adminApiKey');

    if (!expected) {
      throw new ServiceUnavailableException({
        code: 'ADMIN_KEY_NOT_CONFIGURED',
        message:
          "L'enrolement par HTTP est desactive : definissez ADMIN_API_KEY dans " +
          "l'environnement du service pour l'activer.",
      });
    }

    const a = Buffer.from(presented ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException("Cle d'administration invalide.");
    }
  }
}
