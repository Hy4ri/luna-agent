import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { base64UrlEncode } from "./mime.js";
import { MailError } from "./types.js";

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface StoredAccountAuth {
  email: string;
  displayName: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  scope?: string;
  addedAt: number;
}

interface MailAuthFile {
  oauthClient?: OAuthClientConfig;
  accounts: Record<string, StoredAccountAuth>;
}

interface PendingOAuth {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  openerOrigin?: string;
  createdAt: number;
}

function normalizeOpenerOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  const trimmed = origin.trim();
  if (/^(https?|tauri):\/\/[^\s/]+$/i.test(trimmed)) return trimmed;
  return undefined;
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");
const OAUTH_STATE_TTL_MS = 10 * 60_000;

export function parseGoogleCredentialsInput(input: {
  clientId?: string;
  clientSecret?: string;
  credentialsJson?: string;
}): OAuthClientConfig {
  if (input.credentialsJson?.trim()) {
    let parsed: any;
    try {
      parsed = JSON.parse(input.credentialsJson);
    } catch {
      throw new MailError("Invalid credentials.json: must be valid JSON", 400);
    }
    const block = parsed?.installed ?? parsed?.web ?? parsed;
    const clientId = String(block?.client_id ?? block?.clientId ?? "").trim();
    const clientSecret = String(block?.client_secret ?? block?.clientSecret ?? "").trim();
    if (!clientId || !clientSecret) {
      throw new MailError("credentials.json must contain client_id and client_secret", 400);
    }
    return { clientId, clientSecret };
  }
  const clientId = (input.clientId ?? "").trim();
  const clientSecret = (input.clientSecret ?? "").trim();
  if (!clientId || !clientSecret) {
    throw new MailError("clientId and clientSecret are required", 400);
  }
  return { clientId, clientSecret };
}

export class MailAuthStore {
  private readonly filePath: string;
  private readonly fetchImpl: typeof fetch;
  private data: MailAuthFile;
  private pending = new Map<string, PendingOAuth>();
  private refreshing = new Map<string, Promise<string>>();

  constructor(dataDir: string, fetchImpl: typeof fetch = fetch) {
    this.filePath = join(dataDir, "mail-auth.json");
    this.fetchImpl = fetchImpl;
    this.data = this.load();
  }

  private load(): MailAuthFile {
    if (!existsSync(this.filePath)) return { accounts: {} };
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<MailAuthFile>;
      return {
        oauthClient: raw.oauthClient?.clientId && raw.oauthClient?.clientSecret ? raw.oauthClient : undefined,
        accounts: raw.accounts && typeof raw.accounts === "object" ? raw.accounts : {},
      };
    } catch {
      return { accounts: {} };
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    try { chmodSync(this.filePath, 0o600); } catch {}
  }

  hasOAuthClient(): boolean {
    return Boolean(this.data.oauthClient?.clientId && this.data.oauthClient?.clientSecret);
  }

  setOAuthClient(config: OAuthClientConfig): void {
    this.data.oauthClient = { clientId: config.clientId.trim(), clientSecret: config.clientSecret.trim() };
    this.save();
  }

  listAccounts(): StoredAccountAuth[] {
    return Object.values(this.data.accounts).sort((a, b) => a.addedAt - b.addedAt);
  }

  getAccount(email: string): StoredAccountAuth | undefined {
    return this.data.accounts[email.toLowerCase()];
  }

  removeAccount(email: string): boolean {
    const key = email.toLowerCase();
    if (!this.data.accounts[key]) return false;
    delete this.data.accounts[key];
    this.save();
    return true;
  }

  startOAuth(redirectUri: string, openerOrigin?: string): { url: string; state: string; redirectUri: string } {
    const client = this.data.oauthClient;
    if (!client) {
      throw new MailError("Google OAuth client is not configured yet", 400);
    }
    this.pruneExpiredStates();
    const state = base64UrlEncode(randomBytes(24));
    const codeVerifier = base64UrlEncode(randomBytes(32));
    const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());

    this.pending.set(state, {
      state,
      codeVerifier,
      redirectUri,
      openerOrigin: normalizeOpenerOrigin(openerOrigin),
      createdAt: Date.now(),
    });

    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GMAIL_SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    return {
      url: `${GOOGLE_AUTH_URL}?${params.toString()}`,
      state,
      redirectUri,
    };
  }

  peekStateOrigin(state: string): string | undefined {
    const entry = this.pending.get(state);
    if (!entry || Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) return undefined;
    return entry.openerOrigin;
  }

  consumeStateOrigin(state: string): string | undefined {
    const entry = this.pending.get(state);
    this.pending.delete(state);
    if (!entry || Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) return undefined;
    return entry.openerOrigin;
  }

  async finishOAuth(code: string, state: string): Promise<StoredAccountAuth> {
    const entry = this.pending.get(state);
    this.pending.delete(state);
    if (!entry || Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) {
      throw new MailError("Invalid or expired OAuth state", 400);
    }
    const client = this.data.oauthClient;
    if (!client) throw new MailError("Google OAuth client is not configured", 400);

    const tokenRes = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: entry.redirectUri,
        grant_type: "authorization_code",
        code_verifier: entry.codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const tokenBody = (await tokenRes.json().catch(() => ({}))) as Record<string, any>;
    if (!tokenRes.ok || !tokenBody.access_token) {
      const msg = tokenBody.error_description || tokenBody.error || `OAuth token exchange failed (${tokenRes.status})`;
      throw new MailError(String(msg), 502);
    }

    const accessToken = String(tokenBody.access_token);
    const expiresIn = Number(tokenBody.expires_in ?? 3600);
    let refreshToken = tokenBody.refresh_token ? String(tokenBody.refresh_token) : "";

    // Fetch Gmail profile + userinfo for canonical email & display name
    const [profileRes, userRes] = await Promise.all([
      this.fetchImpl(GMAIL_PROFILE_URL, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      }),
      this.fetchImpl(USERINFO_URL, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null),
    ]);

    if (!profileRes.ok) {
      throw new MailError(`Failed to read Gmail profile (${profileRes.status})`, 502);
    }
    const profile = (await profileRes.json()) as { emailAddress?: string };
    const userinfo = userRes && userRes.ok ? ((await userRes.json().catch(() => ({}))) as { name?: string; email?: string }) : {};
    const email = (profile.emailAddress || userinfo.email || "").trim().toLowerCase();
    if (!email) throw new MailError("Google account did not return an email address", 502);

    const existing = this.data.accounts[email];
    if (!refreshToken && existing?.refreshToken) {
      refreshToken = existing.refreshToken;
    }
    if (!refreshToken) {
      throw new MailError("Google did not return a refresh_token. Revoke app access in Google Account permissions and reconnect.", 400);
    }

    const account: StoredAccountAuth = {
      email,
      displayName: (userinfo.name || existing?.displayName || email).trim(),
      refreshToken,
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      scope: tokenBody.scope ? String(tokenBody.scope) : existing?.scope,
      addedAt: existing?.addedAt ?? Date.now(),
    };
    this.data.accounts[email] = account;
    this.save();
    return account;
  }

  async getAccessToken(email: string, forceRefresh = false): Promise<string> {
    const key = email.toLowerCase();
    const account = this.data.accounts[key];
    if (!account) throw new MailError(`Mail account not connected: ${email}`, 404);
    if (!forceRefresh && account.accessToken && account.expiresAt && account.expiresAt > Date.now() + 60_000) {
      return account.accessToken;
    }

    const inflight = this.refreshing.get(key);
    if (inflight) return inflight;

    const promise = this.refreshToken(key).finally(() => {
      this.refreshing.delete(key);
    });
    this.refreshing.set(key, promise);
    return promise;
  }

  private async refreshToken(key: string): Promise<string> {
    const account = this.data.accounts[key];
    if (!account) throw new MailError(`Mail account not connected: ${key}`, 404);
    const client = this.data.oauthClient;
    if (!client) throw new MailError("Google OAuth client is not configured", 400);

    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: account.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !body.access_token) {
      const msg = body.error_description || body.error || `Token refresh failed (${res.status})`;
      throw new MailError(`Gmail auth expired for ${account.email}: ${msg}`, 401);
    }

    account.accessToken = String(body.access_token);
    account.expiresAt = Date.now() + Number(body.expires_in ?? 3600) * 1000;
    this.save();
    return account.accessToken;
  }

  private pruneExpiredStates(): void {
    const now = Date.now();
    for (const [k, v] of this.pending.entries()) {
      if (now - v.createdAt > OAUTH_STATE_TTL_MS) this.pending.delete(k);
    }
  }
}
