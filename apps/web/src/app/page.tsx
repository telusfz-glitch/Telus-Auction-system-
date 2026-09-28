import { redirect } from 'next/navigation';
import { currentViewer } from '@/lib/auth';

const LOGIN_ERRORS: Record<string, string> = {
  expired: 'Your sign-in attempt expired. Please try again.',
  denied: 'This account has no access to TELUS Auctions. Contact your TELUS account manager.',
  error: 'Sign-in failed. Please try again.',
};

export default async function Home({ searchParams }: { searchParams: Promise<{ login?: string }> }) {
  const viewer = await currentViewer();
  if (viewer) redirect(viewer.kind === 'staff' ? '/admin' : '/auctions');
  const { login } = await searchParams;
  return (
    <section className="hero">
      <h1>TELUS Auctions</h1>
      <p>Private device auctions for invited trade customers. Sign in with the account TELUS created for you.</p>
      {login && LOGIN_ERRORS[login] && <p className="banner err">{LOGIN_ERRORS[login]}</p>}
      <a className="btn" href="/auth/login" data-testid="sign-in">Sign in</a>
    </section>
  );
}
