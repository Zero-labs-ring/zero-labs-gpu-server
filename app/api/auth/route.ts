import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getEnvOrThrow } from '@/lib/env-check';

function getAdminAuthToken(): string {
  const user = getEnvOrThrow('ADMIN_USERNAME');
  const pass = getEnvOrThrow('ADMIN_PASSWORD');
  const secret = getEnvOrThrow('ENCRYPTION_KEY');
  return crypto.createHmac('sha256', secret).update(`${user}:${pass}`).digest('hex');
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const username = body?.username;
    const password = body?.password;

    const expectedUser = getEnvOrThrow('ADMIN_USERNAME');
    const expectedPass = getEnvOrThrow('ADMIN_PASSWORD');

    if (username === expectedUser && password === expectedPass) {
      const token = getAdminAuthToken();
      const res = NextResponse.json({ success: true, user: username });
      res.cookies.set('zero_admin_session', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7 days
        path: '/',
      });
      return res;
    }

    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Authentication failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const cookieHeader = req.headers.get('cookie') || '';
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
    );

    const token = cookies['zero_admin_session'];
    const expectedToken = getAdminAuthToken();

    if (token && token === expectedToken) {
      return NextResponse.json({ authenticated: true, user: getEnvOrThrow('ADMIN_USERNAME') });
    }

    return NextResponse.json({ authenticated: false }, { status: 401 });
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
}

export async function DELETE() {
  const res = NextResponse.json({ success: true, message: 'Logged out' });
  res.cookies.set('zero_admin_session', '', {
    httpOnly: true,
    expires: new Date(0),
    path: '/',
  });
  return res;
}
