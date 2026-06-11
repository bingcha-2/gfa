/**
 * Portal / customer-facing types.
 * These match the backend /web/* contract exactly.
 */

export type Customer = {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  referralCode: string;
  creditCents: number;
  status: string;
  createdAt: string;
};

export type PortalSession = {
  accessToken: string;
  customer: Customer;
};
