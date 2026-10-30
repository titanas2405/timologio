// Διεπαφή τερματικού καρτών. Το υπόλοιπο σύστημα μιλάει μόνο με αυτήν· η Viva (ή άλλος πάροχος)
// υλοποιείται ξεχωριστά. Ίδια λογική με τον adapter του myDATA.

export interface SaleRequest {
  sessionId: string; // δικό μας UUID, με αυτό ρωτάμε μετά την κατάσταση
  amountCents: number;
  merchantReference: string; // π.χ. ο αριθμός του τιμολογίου
  customerTrns: string; // κείμενο που βλέπει ο πελάτης
}

export type SessionState =
  | { state: "PENDING" }
  | { state: "SUCCESS"; transactionId?: string; authorizationId?: string; cardType?: string }
  | { state: "FAILED"; message: string };

export interface TerminalInfo {
  terminalId: string;
  statusId?: number;
}

export interface CardTerminal {
  sale(req: SaleRequest): Promise<void>;
  status(sessionId: string): Promise<SessionState>;
  abort(sessionId: string): Promise<void>;
  listTerminals(): Promise<TerminalInfo[]>;
}
