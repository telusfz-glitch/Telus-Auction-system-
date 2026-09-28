export type PrincipalKind = 'staff' | 'customer';
export interface Principal {
  sub: string;
  username: string;
  kind: PrincipalKind;
  roles: string[];
  customerId: string | null;
  customerRole: string | null;
}
