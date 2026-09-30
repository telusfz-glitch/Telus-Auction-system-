export type PrincipalKind = 'staff' | 'customer';
export interface Principal {
  sub: string;
  username: string;
  kind: PrincipalKind;
  roles: string[];
  customerId: string | null;
  customerRole: string | null;
  /** exp of the access token this principal came from (epoch seconds). */
  tokenExp?: number;
}
