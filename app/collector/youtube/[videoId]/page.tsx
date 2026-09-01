import { ReactElement } from 'react';
import YoutubeCollector from './YoutubeCollector';

export const dynamic = 'force-dynamic';

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{6,32}$/;

export default async function YoutubeCollectorPage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}): Promise<ReactElement> {
  const { videoId } = await params;
  if (!YOUTUBE_VIDEO_ID.test(videoId)) {
    return (
      <main className="collector-shell">
        <section className="collector-status">
          <h1>Collector configuration error</h1>
          <p>지원하지 않는 YouTube video ID입니다.</p>
        </section>
      </main>
    );
  }
  return <YoutubeCollector videoId={videoId} />;
}
