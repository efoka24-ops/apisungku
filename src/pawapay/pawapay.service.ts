import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { SigningAlgorithm, SigningConfig, signRequest } from './signing';
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
  private readonly signing?: SigningConfig;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('pawapay.baseUrl')!;
    this.token = config.get<string>('pawapay.apiToken')!;
    this.timeoutMs = config.get<number>('pawapay.timeoutMs')!;
    this.signing = this.loadSigningKey(config);
  }

  /**
   * La signature n'est active que si une cle est fournie. Un compte pawaPay
   * ou les signatures sont exigees rejette sinon toute operation financiere
   * avec HTTP_SIGNATURE_ERROR.
   */
  private loadSigningKey(config: ConfigService): SigningConfig | undefined {
    const inline = config.get<string>('pawapay.signingKey');
    const path = config.get<string>('pawapay.signingKeyPath');
    const keyId = config.get<string>('pawapay.signingKeyId');

    if (!inline && !path) return undefined;

    if (!keyId) {
      throw new Error(
        'PAWAPAY_SIGNING_KEY_ID est requis des lors qu\'une cle de signature est fournie.',
      );
    }

    const pem = inline
      ? inline.replace(/\\n/g, '\n')
      : readFileSync(path!, 'utf8');

    const algorithm = config.get<SigningAlgorithm>('pawapay.signingAlgorithm')!;
    this.logger.log(`Signature des requetes active (${algorithm}, keyid ${keyId}).`);

    return { key: createPrivateKey(pem), keyId, algorithm };
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

  /** Soldes des portefeuilles du compte marchand, par devise. */
  walletBalances(): Promise<unknown> {
    return this.request('GET', '/v2/wallet-balances');
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

    const payload = body === undefined ? undefined : JSON.stringify(body);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    // Seules les requetes porteuses d'un corps sont signees : la signature
    // couvre le condensat de ce corps.
    if (this.signing && payload !== undefined) {
      Object.assign(
        headers,
        signRequest(this.signing, { method, url, body: payload }),
      );
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
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
