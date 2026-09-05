import { ReactElement } from 'react';
import ChzzkCollector from './ChzzkCollector';

export const dynamic = 'force-dynamic';

const CHZZK_CHANNEL_ID = /^[a-f0-9]{32}$/;

export default async function ChzzkCollectorPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}): Promise<ReactElement> {
  const { channelId } = await params;
  if (!CHZZK_CHANNEL_ID.test(channelId)) {
    return (
      <main className="collector-shell">
        <section className="collector-status">
          <h1>Collector configuration error</h1>
          <p>지원하지 않는 치지직 채널 ID입니다.</p>
        </section>
      </main>
    );
  }
  return <ChzzkCollector channelId={channelId} />;
}
