// Passkey（WebAuthn）登入。RP ID 取自請求的 hostname：Passkey 綁網域，workers.dev 與自訂網域要各自新增
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';

const RP_NAME = 'MCP 閘道';
const USER_NAME = 'owner';
const CHALLENGE_TTL = 5 * 60_000;
const MAX_NAME = 60;

/** 可以直接給使用者看的錯誤 */
export class PasskeyError extends Error {}

interface PasskeyRow {
  id: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
}

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** 會同步到其他裝置 */
  synced: boolean;
}

type Purpose = 'register' | 'login';

function relyingParty(requestUrl: string) {
  const url = new URL(requestUrl);
  return { rpID: url.hostname, origin: url.origin };
}

async function saveChallenge(db: D1Database, challenge: string, purpose: Purpose): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM passkey_challenges WHERE expires_at < ?').bind(new Date(now).toISOString()),
    db.prepare('INSERT INTO passkey_challenges (challenge, purpose, expires_at) VALUES (?, ?, ?)')
      .bind(challenge, purpose, new Date(now + CHALLENGE_TTL).toISOString()),
  ]);
}

/** 驗證時才兌換：DELETE … RETURNING 是原子的，同一個 challenge 只會成功一次 */
async function consumeChallenge(db: D1Database, challenge: string, purpose: Purpose): Promise<boolean> {
  const row = await db.prepare('DELETE FROM passkey_challenges WHERE challenge = ? AND purpose = ? AND expires_at > ? RETURNING challenge')
    .bind(challenge, purpose, new Date().toISOString())
    .first();
  return Boolean(row);
}

async function userId(db: D1Database): Promise<Uint8Array<ArrayBuffer>> {
  const fresh = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(16)));
  await db.prepare('INSERT INTO passkey_user (id, user_id) VALUES (1, ?) ON CONFLICT (id) DO NOTHING').bind(fresh).run();
  const row = await db.prepare('SELECT user_id FROM passkey_user WHERE id = 1').first<{ user_id: string }>();
  return isoBase64URL.toBuffer(row!.user_id);
}

/** 函式庫的錯誤訊息是英文且偏技術細節，記在 log，回給使用者統一的說明 */
async function verify<T>(action: Purpose, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.warn(JSON.stringify({ message: 'passkey verify failed', action, error: String(err) }));
    throw new PasskeyError('Passkey 驗證失敗或已逾時，請再試一次');
  }
}

export async function listPasskeys(db: D1Database): Promise<PasskeySummary[]> {
  const { results } = await db.prepare('SELECT id, name, backed_up, created_at, last_used_at FROM passkeys ORDER BY created_at DESC').all<PasskeyRow>();
  return results.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at, synced: Boolean(row.backed_up) }));
}

/** 刪除；找不到回 false */
export async function deletePasskey(db: D1Database, id: string): Promise<boolean> {
  const { meta } = await db.prepare('DELETE FROM passkeys WHERE id = ?').bind(id).run();
  return meta.changes > 0;
}

export async function registrationOptions(db: D1Database, requestUrl: string) {
  const { results } = await db.prepare('SELECT id, transports FROM passkeys').all<Pick<PasskeyRow, 'id' | 'transports'>>();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: relyingParty(requestUrl).rpID,
    userName: USER_NAME,
    userID: await userId(db),
    attestationType: 'none',
    // 同一個驗證器不重複新增
    excludeCredentials: results.map((row) => ({ id: row.id, transports: JSON.parse(row.transports) })),
    // 可探索憑證：登入時不必先輸入帳號。使用者驗證：Face ID、Touch ID、Windows Hello 或裝置 PIN
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await saveChallenge(db, options.challenge, 'register');
  return options;
}

/** 驗證註冊回應並存下憑證 */
export async function registerPasskey(db: D1Database, requestUrl: string, response: RegistrationResponseJSON, name: string): Promise<void> {
  const { rpID, origin } = relyingParty(requestUrl);
  const { verified, registrationInfo } = await verify('register', () =>
    verifyRegistrationResponse({
      response,
      expectedChallenge: (challenge) => consumeChallenge(db, challenge, 'register'),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    }),
  );
  if (!verified || !registrationInfo) throw new PasskeyError('Passkey 驗證失敗，請再試一次');
  const { credential, credentialBackedUp } = registrationInfo;
  await db.prepare('INSERT INTO passkeys (id, public_key, counter, transports, name, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(
      credential.id,
      isoBase64URL.fromBuffer(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      name.trim().slice(0, MAX_NAME) || 'Passkey',
      credentialBackedUp ? 1 : 0,
      new Date().toISOString(),
    )
    .run();
}

export async function authenticationOptions(db: D1Database, requestUrl: string) {
  // 還沒新增過就不叫出瀏覽器的 Passkey 視窗：密碼管理工具裡別的網站的 Passkey 在這裡用不了，只會讓人以為壞了
  if (!(await db.prepare('SELECT 1 FROM passkeys LIMIT 1').first())) {
    throw new PasskeyError('還沒有新增任何 Passkey。請先用密碼登入，到設定頁新增');
  }
  const options = await generateAuthenticationOptions({ rpID: relyingParty(requestUrl).rpID, userVerification: 'required' });
  await saveChallenge(db, options.challenge, 'login');
  return options;
}

export async function authenticatePasskey(db: D1Database, requestUrl: string, response: AuthenticationResponseJSON): Promise<void> {
  const { rpID, origin } = relyingParty(requestUrl);
  const row = await db.prepare('SELECT * FROM passkeys WHERE id = ?').bind(response.id).first<PasskeyRow>();
  if (!row) throw new PasskeyError('找不到這個 Passkey，可能已在設定頁刪除；請改用密碼登入');
  const { verified, authenticationInfo } = await verify('login', () =>
    verifyAuthenticationResponse({
      response,
      expectedChallenge: (challenge) => consumeChallenge(db, challenge, 'login'),
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: row.id, publicKey: isoBase64URL.toBuffer(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) },
      requireUserVerification: true,
    }),
  );
  if (!verified) throw new PasskeyError('Passkey 驗證失敗，請再試一次');
  await db.prepare('UPDATE passkeys SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?')
    .bind(authenticationInfo.newCounter, authenticationInfo.credentialBackedUp ? 1 : 0, new Date().toISOString(), row.id)
    .run();
}
