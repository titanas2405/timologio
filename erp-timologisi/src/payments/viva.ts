// Viva Cloud Terminal API: η πληρωμή στέλνεται στο κινητό με την εφαρμογή Viva Terminal (SoftPOS)
// και το ERP ρωτάει την κατάσταση της συνεδρίας μέχρι ο πελάτης να ακουμπήσει την κάρτα.
// Τεκμηρίωση: developer.viva.com (Cloud Terminal / ECR API).
import { HttpError } from "../errors.js";
import type { Fetch } from "../registry/types.js";
import type { CardTerminal, SaleRequest, SessionState, TerminalInfo } from "./terminal.js";

export interface VivaConfig {
  environment: "demo" | "live";
  clientId: string;
  clientSecret: string;
  terminalId: string;
  cashRegisterId: string;
}

const HOSTS = {
  demo: { api: "https://demo-api.vivapayments.com", accounts: "https://demo-accounts.vivapayments.com" },
  live: { api: "https://api.vivapayments.com", accounts: "https://accounts.vivapayments.com" },
};

// Μηνύματα για τους κωδικούς αποτελέσματος (eventId) της συνεδρίας
const EVENT_MESSAGES: Record<number, string> = {
  1003: "Έληξε ο χρόνος στο τερματικό",
  1006: "Η συναλλαγή απορρίφθηκε",
  1016: "Η συναλλαγή ακυρώθηκε",
  1020: "Ανεπαρκές υπόλοιπο",
  1099: "Γενικό σφάλμα τερματικού",
  6000: "Λάθος παράμετροι συναλλαγής",
};
const IN_PROGRESS = 1100;

// Token ανά (περιβάλλον, client): ανανεώνεται 60'' πριν λήξει
const tokens = new Map<string, { token: string; expires: number }>();

export class VivaCloudTerminal implements CardTerminal {
  constructor(
    private fetchFn: Fetch,
    private cfg: Pick<VivaConfig, "environment" | "clientId" | "clientSecret"> & Partial<VivaConfig>,
  ) {}

  private get hosts() {
    return HOSTS[this.cfg.environment];
  }

  private async token(): Promise<string> {
    const key = `${this.cfg.environment}:${this.cfg.clientId}`;
    const cached = tokens.get(key);
    if (cached && cached.expires > Date.now()) return cached.token;
    const res = await this.call(`${this.hosts.accounts}/connect/token`, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (res.status === 400 || res.status === 401) throw new HttpError(422, "Viva: λάθος Client ID ή Client Secret");
    if (!res.ok) throw new HttpError(502, `Viva: αποτυχία σύνδεσης (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    tokens.set(key, { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 });
    return body.access_token;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new HttpError(502, "Η Viva δεν απαντά. Ελέγξτε τη σύνδεση και δοκιμάστε ξανά.");
    }
  }

  private async api(path: string, init: RequestInit = {}): Promise<Response> {
    return this.call(`${this.hosts.api}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json", ...init.headers },
    });
  }

  private requireTerminal() {
    if (!this.cfg.terminalId || !this.cfg.cashRegisterId) throw new HttpError(422, "Δεν έχει οριστεί τερματικό Viva");
    return { terminalId: this.cfg.terminalId, cashRegisterId: this.cfg.cashRegisterId };
  }

  async sale(req: SaleRequest): Promise<void> {
    const res = await this.api("/ecr/v1/transactions:sale", {
      method: "POST",
      body: JSON.stringify({
        sessionId: req.sessionId,
        ...this.requireTerminal(),
        amount: req.amountCents,
        currencyCode: "978", // EUR
        merchantReference: req.merchantReference,
        customerTrns: req.customerTrns,
        tipAmount: 0,
        showReceipt: true,
        showTransactionResult: true,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(502, `Viva: η χρέωση δεν ξεκίνησε (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
  }

  async status(sessionId: string): Promise<SessionState> {
    const res = await this.api(`/ecr/v1/sessions/${sessionId}`);
    // Μέχρι να την παραλάβει το τερματικό, η συνεδρία μπορεί να μην υπάρχει ακόμα
    if (res.status === 404) return { state: "PENDING" };
    if (!res.ok) throw new HttpError(502, `Viva: αποτυχία ελέγχου συναλλαγής (${res.status})`);
    const s = (await res.json()) as {
      success?: boolean;
      eventId?: number;
      message?: string;
      transactionId?: string;
      authorizationId?: string;
      cardType?: string;
    };
    if (s.eventId === IN_PROGRESS) return { state: "PENDING" };
    if (s.success) return { state: "SUCCESS", transactionId: s.transactionId, authorizationId: s.authorizationId, cardType: s.cardType };
    return { state: "FAILED", message: EVENT_MESSAGES[s.eventId ?? -1] ?? s.message ?? "Η συναλλαγή απέτυχε" };
  }

  async abort(sessionId: string): Promise<void> {
    const { cashRegisterId } = this.requireTerminal();
    const res = await this.api(`/ecr/v1/sessions/${sessionId}?cashRegisterId=${encodeURIComponent(cashRegisterId)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new HttpError(502, `Viva: η ακύρωση απέτυχε (${res.status})`);
  }

  async listTerminals(): Promise<TerminalInfo[]> {
    const res = await this.api("/ecr/v1/devices:search", { method: "POST", body: JSON.stringify({}) });
    if (!res.ok) throw new HttpError(502, `Viva: αποτυχία λήψης τερματικών (${res.status})`);
    const list = (await res.json()) as { terminalId: string | number; statusId?: number }[];
    return list.map((d) => ({ terminalId: String(d.terminalId), statusId: d.statusId }));
  }
}
