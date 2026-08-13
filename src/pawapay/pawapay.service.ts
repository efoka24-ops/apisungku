import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  PawaPayInitiationResponse,
  PawaPayPredictProviderResponse,
  PawaPayRejectedError,
  PawaPayStatusResponse,
  PawaPayUnavailableError,
} from './pawapay.types';

type OperationPath = 'deposits' | 'payouts' | 'refunds';

/**
 * Client bas niveau de l'API pawaPay. C'est le seul endroit du service qui
 * connait pawaPay ; tout le reste manipule nos propres types.
 */
@Injectable()
export class PawaPayService {
  private readonly logger = new Logger(PawaPayService.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('pawapay.baseUrl')!;
    this.token = config.get<string>('pawapay.apiToken')!;
    this.timeoutMs = config.get<number>('pawapay.timeoutMs')!;
  }

  // ─── Operations ──────────────────────────────────────────────────────────

  initiateDeposit(body: unknown): Promise<PawaPayInitiationResponse> {
    return this.request('POST', '/v2/deposits', body);
  }

  initiatePayout(body: unknown): Promise<PawaPayInitiationResponse> {
    return this.request('POST', '/v2/payouts', body);
  }

  initiateRefund(body: unknown): Promise<PawaPayInitiationResponse> {
    return this.request('POST', '/v2/refunds', body);
  }

  /**
   * Verifie le statut reel d'une operation. C'est l'appel de reference : on
   * s'en sert aussi bien pour la reconciliation que pour re-verifier chaque
   * callback entrant plutot que de faire confiance a son contenu.
   */
  checkStatus(
    operation: OperationPath,
    id: string,
  ): Promise<PawaPayStatusResponse> {
    return this.request('GET', `/v2/${operation}/${id}`);
  }

  // ─── Toolkit ─────────────────────────────────────────────────────────────

  activeConfiguration(params: {
    country?: string;
    operationType?: string;
  }): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.country) query.set('country', params.country);
    if (params.operationType) query.set('operationType', params.operationType);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.request('GET', `/v2/active-conf${suffix}`);
  }

  predictProvider(
    phoneNumber: string,
  ): Promise<PawaPayPredictProviderResponse> {
    return this.request('POST', '/v2/predict-provider', { phoneNumber });
  }

  availability(country?: string): Promise<unknown> {
    const suffix = country ? `?country=${encodeURIComponent(country)}` : '';
    return this.request('GET', `/v2/availability${suffix}`);
  }

  // ─── Transport ───────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // Timeout, DNS, TCP : on ne sait pas si pawaPay a recu la demande.
      throw new PawaPayUnavailableError(
        `Appel ${method} ${path} interrompu avant reponse.`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    let parsed: unknown = undefined;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
    }

    if (response.status >= 500 || response.status === 429) {
      // Idem : issue indeterminee, il faudra verifier le statut.
      throw new PawaPayUnavailableError(
        `pawaPay a repondu ${response.status} sur ${method} ${path}.`,
        parsed ?? raw,
      );
    }

    if (!response.ok) {
      const failure = (parsed as { failureReason?: Record<string, string> })
        ?.failureReason;
      throw new PawaPayRejectedError(
        failure?.failureCode ?? 'INVALID_REQUEST',
        failure?.failureMessage ??
          `pawaPay a refuse l'appel ${method} ${path} (HTTP ${response.status}).`,
        response.status,
      );
    }

    return parsed as T;
  }
}
