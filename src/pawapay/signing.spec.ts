import { createPrivateKey, createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';

import { buildSignatureBase, contentDigest, signRequest } from './signing';

describe('condensat du corps', () => {
  it('produit la forme sha-512=:base64:', () => {
    const digest = contentDigest('{"a":1}');
    expect(digest).toMatch(/^sha-512=:[A-Za-z0-9+/]+=*:$/);
  });

  it('change des qu\'un octet du corps change', () => {
    expect(contentDigest('{"a":1}')).not.toBe(contentDigest('{"a":2}'));
  });
});

describe('base de signature', () => {
  const params = {
    method: 'POST',
    authority: 'api.pawapay.io',
    path: '/v2/deposits',
    signatureDate: '2024-05-02T15:36:45.058799Z',
    digest: 'sha-512=:abc==:',
    keyId: 'CUSTOMER_TEST_KEY',
    algorithm: 'ecdsa-p256-sha256' as const,
    created: 1714653405,
    expires: 1714653465,
  };

  it('respecte l\'ordre et le format des composants couverts', () => {
    const { base } = buildSignatureBase(params);

    expect(base.split('\n')).toEqual([
      '"@method": POST',
      '"@authority": api.pawapay.io',
      '"@path": /v2/deposits',
      '"signature-date": 2024-05-02T15:36:45.058799Z',
      '"content-digest": sha-512=:abc==:',
      '"content-type": application/json',
      '"@signature-params": ("@method" "@authority" "@path" "signature-date" ' +
        '"content-digest" "content-type");alg="ecdsa-p256-sha256";' +
        'keyid="CUSTOMER_TEST_KEY";created=1714653405;expires=1714653465',
    ]);
  });

  it('ne se termine pas par un saut de ligne', () => {
    expect(buildSignatureBase(params).base.endsWith('\n')).toBe(false);
  });
});

describe('signature ECDSA P-256', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  const body = '{"depositId":"x","amount":"5"}';

  it('produit des en-tetes verifiables avec la cle publique', () => {
    const headers = signRequest(
      { key: privateKey, keyId: 'TEST_KEY', algorithm: 'ecdsa-p256-sha256' },
      { method: 'POST', url: 'https://api.pawapay.io/v2/deposits', body },
    );

    // On reconstruit la base a partir des en-tetes emis, comme le ferait
    // pawaPay, et on verifie la signature avec la cle publique.
    const input = headers['Signature-Input'].replace(/^sig-pp=/, '');
    const created = Number(/created=(\d+)/.exec(input)![1]);
    const expires = Number(/expires=(\d+)/.exec(input)![1]);

    const { base } = buildSignatureBase({
      method: 'POST',
      authority: 'api.pawapay.io',
      path: '/v2/deposits',
      signatureDate: headers['Signature-Date'],
      digest: headers['Content-Digest'],
      keyId: 'TEST_KEY',
      algorithm: 'ecdsa-p256-sha256',
      created,
      expires,
    });

    const signature = headers.Signature.replace(/^sig-pp=:/, '').replace(/:$/, '');

    const verifier = createVerify('sha256');
    verifier.update(base, 'utf8');
    verifier.end();

    expect(
      verifier.verify(
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true);
  });

  it('produit une signature au format brut r||s, pas DER', () => {
    const headers = signRequest(
      { key: privateKey, keyId: 'TEST_KEY', algorithm: 'ecdsa-p256-sha256' },
      { method: 'POST', url: 'https://api.pawapay.io/v2/deposits', body },
    );

    const raw = Buffer.from(
      headers.Signature.replace(/^sig-pp=:/, '').replace(/:$/, ''),
      'base64',
    );

    // P-256 : deux entiers de 32 octets. Une signature DER ferait une taille
    // variable et commencerait par 0x30, ce que pawaPay rejette.
    expect(raw.length).toBe(64);
    expect(raw[0]).not.toBe(0x30);
  });

  it('expire une minute apres sa creation', () => {
    const headers = signRequest(
      { key: privateKey, keyId: 'TEST_KEY', algorithm: 'ecdsa-p256-sha256' },
      { method: 'POST', url: 'https://api.pawapay.io/v2/deposits', body },
    );

    const input = headers['Signature-Input'];
    const created = Number(/created=(\d+)/.exec(input)![1]);
    const expires = Number(/expires=(\d+)/.exec(input)![1]);

    expect(expires - created).toBe(60);
  });
});

describe('chargement d\'une cle PEM', () => {
  it('accepte une cle EC au format PEM', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    expect(() => createPrivateKey(pem)).not.toThrow();
    expect(createPublicKey(pem).asymmetricKeyType).toBe('ec');
  });
});
