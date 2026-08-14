import { createHash, createSign, KeyObject } from 'node:crypto';

/**
 * Signature des requetes selon RFC 9421 (HTTP Message Signatures), dans la
 * variante attendue par pawaPay.
 *
 * Interet : le token d'API seul ne suffit plus a initier un paiement. Un token
 * qui fuite reste inexploitable sans la cle privee, qui elle ne quitte jamais
 * le serveur.
 */

export type SigningAlgorithm =
  | 'ecdsa-p256-sha256'
  | 'ecdsa-p384-sha384'
  | 'rsa-pss-sha512'
  | 'rsa-v1_5-sha256';

export interface SigningConfig {
  key: KeyObject;
  keyId: string;
  algorithm: SigningAlgorithm;
}

/** Composants couverts, dans l'ordre exact impose par la specification. */
const COVERED_COMPONENTS = [
  '@method',
  '@authority',
  '@path',
  'signature-date',
  'content-digest',
  'content-type',
] as const;

const CONTENT_TYPE = 'application/json';

interface NodeSignParams {
  hash: string;
  options: { dsaEncoding?: 'ieee-p1363'; padding?: number; saltLength?: number };
}

function nodeParams(algorithm: SigningAlgorithm): NodeSignParams {
  switch (algorithm) {
    case 'ecdsa-p256-sha256':
      // RFC 9421 exige la forme brute r||s. Node produit du DER par defaut,
      // que pawaPay rejetterait.
      return { hash: 'sha256', options: { dsaEncoding: 'ieee-p1363' } };
    case 'ecdsa-p384-sha384':
      return { hash: 'sha384', options: { dsaEncoding: 'ieee-p1363' } };
    case 'rsa-v1_5-sha256':
      return { hash: 'sha256', options: {} };
    case 'rsa-pss-sha512':
      return {
        hash: 'sha512',
        options: {
          // RSASSA-PSS : longueur de sel egale a celle du condensat.
          padding: 6 /* RSA_PKCS1_PSS_PADDING */,
          saltLength: 64,
        },
      };
  }
}

/** Condensat du corps, au format `sha-512=:base64:`. */
export function contentDigest(body: string): string {
  const hash = createHash('sha512').update(body, 'utf8').digest('base64');
  return `sha-512=:${hash}:`;
}

export interface SignedHeaders {
  'Content-Digest': string;
  'Signature-Date': string;
  Signature: string;
  'Signature-Input': string;
  'Accept-Signature': string;
  'Accept-Digest': string;
}

/**
 * Construit la base de signature puis les en-tetes correspondants.
 * Exporte separement pour etre testable sans cle ni reseau.
 */
export function buildSignatureBase(params: {
  method: string;
  authority: string;
  path: string;
  signatureDate: string;
  digest: string;
  keyId: string;
  algorithm: SigningAlgorithm;
  created: number;
  expires: number;
}): { base: string; signatureParams: string } {
  const components = COVERED_COMPONENTS.map((c) => `"${c}"`).join(' ');
  const signatureParams =
    `(${components});alg="${params.algorithm}";keyid="${params.keyId}";` +
    `created=${params.created};expires=${params.expires}`;

  const base = [
    `"@method": ${params.method.toUpperCase()}`,
    `"@authority": ${params.authority}`,
    `"@path": ${params.path}`,
    `"signature-date": ${params.signatureDate}`,
    `"content-digest": ${params.digest}`,
    `"content-type": ${CONTENT_TYPE}`,
    `"@signature-params": ${signatureParams}`,
  ].join('\n');

  return { base, signatureParams };
}

export function signRequest(
  config: SigningConfig,
  request: { method: string; url: string; body: string },
): SignedHeaders {
  const url = new URL(request.url);
  const now = new Date();
  const created = Math.floor(now.getTime() / 1000);
  // Fenetre courte : une signature capturee devient inutilisable en une minute.
  const expires = created + 60;

  const signatureDate = now.toISOString();
  const digest = contentDigest(request.body);

  const { base, signatureParams } = buildSignatureBase({
    method: request.method,
    authority: url.host,
    path: url.pathname,
    signatureDate,
    digest,
    keyId: config.keyId,
    algorithm: config.algorithm,
    created,
    expires,
  });

  const { hash, options } = nodeParams(config.algorithm);
  const signer = createSign(hash);
  signer.update(base, 'utf8');
  signer.end();
  const signature = signer.sign({ key: config.key, ...options }, 'base64');

  return {
    'Content-Digest': digest,
    'Signature-Date': signatureDate,
    Signature: `sig-pp=:${signature}:`,
    'Signature-Input': `sig-pp=${signatureParams}`,
    'Accept-Signature':
      'rsa-pss-sha512,ecdsa-p256-sha256,rsa-v1_5-sha256,ecdsa-p384-sha384',
    'Accept-Digest': 'sha-256,sha-512',
  };
}
