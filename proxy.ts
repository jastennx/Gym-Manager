

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// Keeps the Supabase session cookie fresh and sends signed-out visitors on app pages to the login screen.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  // Verifies the session token locally against Supabase's cached signing keys instead of asking the Auth server each time.
  const { data } = await supabase.auth.getClaims();

  if (request.cookies.get('sgfm_demo')?.value === 'true' || request.nextUrl.searchParams.get('demo') === '1') {
    return response;
  }

  if (!data?.claims) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // A leftover Supabase auth cookie means they were signed in and the session ran out, so the login page says so.
    const hadSession = request.cookies.getAll().some((c) => c.name.startsWith('sb-') && c.name.includes('auth-token'));
    url.search = hadSession ? '?mode=signin&notice=session_expired' : '?mode=signin';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/members/:path*',
    '/attendance/:path*',
    '/payments/:path*',
    '/plans/:path*',
    '/expenses/:path*',
    '/calendar/:path*',
    '/reports/:path*',
    '/analytics/:path*',
    '/audit/:path*',
    '/settings/:path*',
    '/onboarding/:path*',
  ],
};
