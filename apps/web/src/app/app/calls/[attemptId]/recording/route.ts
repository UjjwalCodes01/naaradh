import { NextResponse } from 'next/server';
import { accessMedia, roleAtLeast } from '@naaradh/pipeline';
import { isNaaradhError } from '@naaradh/shared';
import { media } from '@/lib/server';
import { actorOf, currentSession, inTenant } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Recording playback (SPEC §9.1, E-74): operator role and above; the access is audited first,
 * then the browser is redirected to a 15-minute signed GCS URL. The vendor URL is never used.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const s = await currentSession();
  if (s === null) return new NextResponse('Sign in required', { status: 401 });
  if (!roleAtLeast(s.role, 'operator'))
    return new NextResponse('Not allowed for your role', { status: 403 });
  const { attemptId } = await params;
  try {
    const uri = await inTenant(s, (tx) => accessMedia(tx, actorOf(s), attemptId, 'recording'));
    const url = await media().signedUrl(uri, 15 * 60);
    return NextResponse.redirect(url, {
      status: 302,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (isNaaradhError(error) && error.code === 'NOT_FOUND')
      return new NextResponse('Not found', { status: 404 });
    throw error;
  }
}
