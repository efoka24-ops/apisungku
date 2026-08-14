import { isFinal, mapProviderStatus } from './transactions.service';
import {
  extractPrefix,
  generateApiKey,
  hashApiKey,
  safeCompare,
} from '../auth/api-key.util';

describe('mapProviderStatus', () => {
  it('traduit les statuts finaux', () => {
    expect(mapProviderStatus('COMPLETED')).toBe('COMPLETED');
    expect(mapProviderStatus('FAILED')).toBe('FAILED');
  });

  it('regroupe les statuts intermediaires', () => {
    for (const status of [
      'ACCEPTED',
      'ENQUEUED',
      'SUBMITTED',
      'PROCESSING',
      // Observe en production sur un paiement Orange Cameroun.
      'IN_RECONCILIATION',
    ]) {
      expect(mapProviderStatus(status)).toBe('PROCESSING');
    }
  });

  it('escalade tout statut inconnu au lieu de deviner', () => {
    expect(mapProviderStatus('QUELQUE_CHOSE_DE_NOUVEAU')).toBe('NEEDS_ATTENTION');
  });
});

describe('isFinal', () => {
  it('ne considere comme final que COMPLETED et FAILED', () => {
    expect(isFinal('COMPLETED')).toBe(true);
    expect(isFinal('FAILED')).toBe(true);
    expect(isFinal('PENDING')).toBe(false);
    expect(isFinal('PROCESSING')).toBe(false);
    expect(isFinal('NEEDS_ATTENTION')).toBe(false);
  });
});

describe('cles API', () => {
  const salt = 'sel-de-test';

  it('produit une cle dont le prefixe est extractible', () => {
    const key = generateApiKey(salt, 'test');
    expect(key.plaintext.startsWith('sk_test_')).toBe(true);
    expect(extractPrefix(key.plaintext)).toBe(key.prefix);
  });

  it('rehache la meme cle a l identique', () => {
    const key = generateApiKey(salt, 'test');
    expect(hashApiKey(key.plaintext, salt)).toBe(key.hash);
  });

  it('ne valide pas une cle hachee avec un autre sel', () => {
    const key = generateApiKey(salt, 'test');
    expect(safeCompare(hashApiKey(key.plaintext, 'autre-sel'), key.hash)).toBe(false);
  });

  it('rejette une cle mal formee', () => {
    expect(extractPrefix('nimportequoi')).toBeNull();
    expect(extractPrefix('pk_test_aaa_bbb')).toBeNull();
  });
});
