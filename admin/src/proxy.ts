import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Server-side guard for platform-admin routes (FIX 2).
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy` (see
 * node_modules/next/dist/docs/01-app/.../proxy.md). This runs on the server
 * BEFORE the page renders, so a non-admin can't even mount the admin shell —
 * unlike the client-side `useEffect` redirect in (protected)/layout.tsx, which
 * only fires after hydration.
 *
 * The `ecf-admin` cookie ('1' = super-admin) is written client-side from the
 * backend-derived `isSuperAdmin` flag (see lib/auth-store.ts). This is
 * defense-in-depth: the REAL authorization boundary is the backend, where every
 * /admin/* endpoint is gated by @RequireScopes(ApiKeyScope.ADMIN) and returns
 * 403. A forged cookie still grants no data access.
 */

// Mirrors ADMIN_ONLY_PREFIXES in components/layout/nav-items.ts. Inlined because
// Proxy runs separately from the app and matcher values must be static literals.
const ADMIN_ONLY_PREFIXES = ['/dashboard', '/tenants', '/billing', '/audit-logs', '/health'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isAdminPath = ADMIN_ONLY_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );
  // Tenant routes (/companies, /invoices, ...), /login, /home, etc. pass through.
  if (!isAdminPath) return NextResponse.next();

  const isAdmin = request.cookies.get('ecf-admin')?.value === '1';
  if (isAdmin) return NextResponse.next();

  // Non-admin (or not-yet-authenticated) hitting an admin route → 307 to /home,
  // server-side, before any admin UI is rendered. The layout then sends a
  // token-less user on to /login.
  const url = request.nextUrl.clone();
  url.pathname = '/home';
  return NextResponse.redirect(url, 307);
}

export const config = {
  // Broad matcher (excluding API + static assets) so the proxy also runs for the
  // bare admin paths (e.g. exactly /dashboard), not only their sub-paths.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
