import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { currentViewer, hasRole } from '@/lib/auth';
import './globals.css';

export const metadata: Metadata = { title: 'TELUS Auctions', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const viewer = await currentViewer();
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">TELUS <span>Auctions</span></Link>
          {viewer && (
            <nav>
              {viewer.kind === 'customer' ? (
                <>
                  <Link href="/auctions">My auctions</Link>
                  <Link href="/invoices">Invoices</Link>
                  <Link href="/team">Team</Link>
                </>
              ) : (
                <>
                  <Link href="/admin">Auctions</Link>
                  <Link href="/admin/customers">Customers</Link>
                  <Link href="/admin/invoices">Invoices</Link>
                  <Link href="/admin/settings">Settings</Link>
                </>
              )}
            </nav>
          )}
          {viewer && (
            <div className="who">
              <span data-testid="whoami">{viewer.name}</span>
              <small>{viewer.kind === 'staff' ? viewer.roles.join(', ') : viewer.customerRole}</small>
              <form action="/auth/logout" method="post">
                <button type="submit" className="btn link">Sign out</button>
              </form>
              {hasRole(viewer, 'customer_viewer') && <small className="tag">view only</small>}
            </div>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
