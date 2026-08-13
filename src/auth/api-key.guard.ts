import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

import { PrismaService } from '../common/prisma.service';
import { extractPrefix, hashApiKey, safeCompare } from './api-key.util';

export interface AuthenticatedRequest extends Request {
  tenant: { id: string; slug: string; name: string; webhookUrl: string | null };
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const presented = this.readKey(request);
    if (!presented) {
      throw new UnauthorizedException("Cle API absente (en-tete X-Api-Key).");
    }

    const prefix = extractPrefix(presented);
    if (!prefix) throw new UnauthorizedException('Cle API invalide.');

    const record = await this.prisma.apiKey.findUnique({
      where: { prefix },
      include: { tenant: true },
    });

    // Meme message d'erreur dans tous les cas d'echec : on ne revele pas si le
    // prefixe existe, si la cle est revoquee ou si le projet est desactive.
    const expected = hashApiKey(presented, this.config.get<string>('apiKeySalt')!);
    if (
      !record ||
      record.revokedAt !== null ||
      !record.tenant.active ||
      !safeCompare(record.hash, expected)
    ) {
      throw new UnauthorizedException('Cle API invalide.');
    }

    request.tenant = {
      id: record.tenant.id,
      slug: record.tenant.slug,
      name: record.tenant.name,
      webhookUrl: record.tenant.webhookUrl,
    };

    // Trace de derniere utilisation, sans bloquer la requete.
    void this.prisma.apiKey
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return true;
  }

  private readKey(request: Request): string | null {
    const header = request.headers['x-api-key'];
    if (typeof header === 'string' && header.length > 0) return header;

    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);

    return null;
  }
}
