// 軟體驗證器：扮演瀏覽器與 Passkey，產生 WebAuthn 的註冊與登入回應（attestation 用 none、金鑰用 ES256）。
// 只走閘道公開的 HTTP 介面，伺服器端照真的 WebAuthn 驗證
import { ORIGIN } from './oauth';

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// 最小的 CBOR 編碼：只用到整數、位元組、字串與 map
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 256) return Uint8Array.of((major << 5) | 24, length);
  return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
}

function cbor(value: Cbor): Uint8Array {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = encoder.encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

/** WebCrypto 的 ECDSA 簽章是 r||s，WebAuthn 要 DER */
function der(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const trimmed = bytes.slice(i);
    const body = trimmed[0] & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
    return concat(Uint8Array.of(0x02, body.length), body);
  };
  const seq = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(Uint8Array.of(0x30, seq.length), seq);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

interface Options {
  challenge: string;
  rp?: { id: string };
  rpId?: string;
  user?: { id: string };
}

export class Authenticator {
  readonly id = crypto.getRandomValues(new Uint8Array(16));
  private keys!: CryptoKeyPair;
  private counter = 0;
  /** 註冊時伺服器給的 user.id，登入回應要帶回去 */
  private userHandle = '';

  get credentialId(): string {
    return base64url(this.id);
  }

  private async init() {
    this.keys ??= (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): Uint8Array {
    return encoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** 對註冊選項產生 navigator.credentials.create 的回應 */
  async create(options: Options, origin = ORIGIN) {
    await this.init();
    this.userHandle = options.user?.id ?? '';
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
    const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const coseKey = cbor(new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, fromB64(jwk.x!)], [-3, fromB64(jwk.y!)]]));
    const authData = concat(
      await sha256(encoder.encode(options.rp?.id ?? new URL(origin).hostname)),
      Uint8Array.of(0x45), // UP | UV | AT
      new Uint8Array(4),
      new Uint8Array(16), // AAGUID
      Uint8Array.of(this.id.length >> 8, this.id.length & 0xff),
      this.id,
      coseKey,
    );
    const attestationObject = cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(this.clientData('webauthn.create', options.challenge, origin)),
        attestationObject: base64url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** 對登入選項產生 navigator.credentials.get 的回應 */
  async get(options: Options, origin = ORIGIN) {
    await this.init();
    this.counter += 1;
    const authData = concat(
      await sha256(encoder.encode(options.rpId ?? new URL(origin).hostname)),
      Uint8Array.of(0x05), // UP | UV
      Uint8Array.of(this.counter >> 24, (this.counter >> 16) & 0xff, (this.counter >> 8) & 0xff, this.counter & 0xff),
    );
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, origin);
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientDataJSON),
        authenticatorData: base64url(authData),
        signature: base64url(der(raw)),
        userHandle: this.userHandle || undefined,
      },
    };
  }
}
