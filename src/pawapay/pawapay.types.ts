/** Statuts renvoyes par pawaPay a l'initiation d'une operation. */
export type PawaPayInitiationStatus =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'DUPLICATE_IGNORED'
  | 'FAILED';

/** Statuts d'une operation en cours ou terminee. */
export type PawaPayTransactionStatus =
  | 'ACCEPTED'
  | 'ENQUEUED'
  | 'SUBMITTED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

export interface PawaPayFailureReason {
  failureCode: string;
  failureMessage: string;
}

export interface PawaPayAccountDetails {
  phoneNumber: string;
  provider: string;
}

export interface PawaPayParty {
  type: 'MMO';
  accountDetails: PawaPayAccountDetails;
}

export interface PawaPayInitiationResponse {
  depositId?: string;
  payoutId?: string;
  refundId?: string;
  status: PawaPayInitiationStatus;
  nextStep?: string;
  created?: string;
  failureReason?: PawaPayFailureReason;
}

export interface PawaPayTransactionData {
  depositId?: string;
  payoutId?: string;
  refundId?: string;
  status: PawaPayTransactionStatus;
  amount?: string;
  currency?: string;
  country?: string;
  payer?: PawaPayParty;
  recipient?: PawaPayParty;
  created?: string;
  providerTransactionId?: string;
  failureReason?: PawaPayFailureReason;
  metadata?: Record<string, unknown>;
}

/**
 * Reponse des endpoints de verification de statut. Le distinguo entre
 * NOT_FOUND (l'operation n'a jamais atteint pawaPay) et une erreur reseau est
 * ce qui permet de conclure a un echec en toute securite.
 */
export interface PawaPayStatusResponse {
  status: 'FOUND' | 'NOT_FOUND';
  data?: PawaPayTransactionData;
}

export interface PawaPayPredictProviderResponse {
  country: string;
  provider: string;
  phoneNumber: string;
}

/** Erreur levee quand l'issue de l'appel est indeterminee (reseau, 5xx). */
export class PawaPayUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PawaPayUnavailableError';
  }
}

/** Erreur levee quand pawaPay a repondu clairement, mais en refusant. */
export class PawaPayRejectedError extends Error {
  constructor(
    readonly failureCode: string,
    readonly failureMessage: string,
    readonly httpStatus: number,
  ) {
    super(failureMessage);
    this.name = 'PawaPayRejectedError';
  }
}
