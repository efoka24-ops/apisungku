import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { AuthenticatedRequest } from './api-key.guard';

/** Injecte le projet authentifie dans la signature du controleur. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().tenant,
);

export type TenantContext = AuthenticatedRequest['tenant'];
