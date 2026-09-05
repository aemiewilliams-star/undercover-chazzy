import { ReactElement } from 'react';
import { CHZZK_VIDEO_NO } from '../../../chzzk/chzzkVideoChat';
import ChzzkVideoCollector from './ChzzkVideoCollector';

export const dynamic = 'force-dynamic';

export default async function ChzzkVideoCollectorPage({
  params,
}: {
  params: Promise<{ videoNo: string }>;
}): Promise<ReactElement> {
  const { videoNo } = await params;
  if (!CHZZK_VIDEO_NO.test(videoNo)) {
    return (
      <main className="collector-shell">
        <section className="collector-status">
          <h1>Collector configuration error</h1>
          <p>지원하지 않는 치지직 영상 번호입니다.</p>
        </section>
      </main>
    );
  }
  return <ChzzkVideoCollector videoNo={videoNo} />;
}
