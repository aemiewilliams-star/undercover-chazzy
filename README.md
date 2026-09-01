# UNDERCOVER Live Chat Collector

UNDERCOVER의 실시간 동향 랭킹을 위해 YouTube 라이브 채팅을 수집하고, 식별정보를 최소화한 이벤트만 Flutter WebView 브리지로 전달하는 독립 collector입니다.

이 저장소는 [AiOO/chazzy](https://github.com/AiOO/chazzy)의 `add-chazzy` 브랜치, 커밋 `fcdde23dd8f748fb37117c4e27b49d831427dfe0`에서 파생했습니다. 원본과 이 수정본은 GNU Affero General Public License v3.0에 따릅니다. 자세한 계보와 배포 의무는 [NOTICE.md](./NOTICE.md)를 확인하세요.

## Collector 계약

운영 경로는 다음 하나입니다.

```text
/collector/youtube/{youtubeVideoId}
```

- Flutter가 페이지 로드 후 `undercoverLiveChatCollectorBootstrap` 핸들러로 `bridgeToken`과 `collectorRunId`를 반환합니다. 두 값은 URL에 넣지 않습니다.
- 페이지는 `undercoverLiveChatCollector` 핸들러로 `ready`, `batch`, `heartbeat`, `platform_status` 메시지를 전달합니다.
- batch는 최대 100건, 페이지 큐는 최대 10,000건입니다. bridge 실패 batch는 같은 event sequence로 큐 앞에 복원합니다.
- heartbeat는 2초 간격이며 provider 요청 시작·성공 시각과 마지막 채팅 시각을 구분합니다.
- YouTube 연결 실패는 1·2·4·8·16초 후 최대 5회 재시도합니다. provider 성공이 60초 동안 없거나 stream이 끝나면 재연결합니다.
- 운영 모드에서는 기존 Chazzy overlay 경로를 404로 막고 collector 경로만 제공합니다.

## 개인정보 경계

collector route는 YouTube `LiveChatTextMessage`에서 다음 값만 읽습니다.

- `author.id`: Flutter가 세션별 HMAC을 만들기 위한 불투명 key
- `timestamp`: Unix epoch milliseconds UTC로 정규화
- `message.runs`: 500 Unicode codepoint 이하의 정규화된 텍스트

닉네임, badge, avatar/profile image, emoji image URL, Super Chat 금액은 bridge payload에 포함하지 않습니다. URL·이메일·전화번호·멘션은 placeholder로 치환하고 emoji image는 `[이모지]`로 바꿉니다. 앱 인증 cookie나 API token은 collector 페이지에 주입하지 않습니다.

## 환경 변수

`.env.example`을 기준으로 설정합니다.

```env
NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL=https://collector.example.com
NEXT_PUBLIC_COLLECTOR_BRIDGE_DEBUG=0
NEXT_PUBLIC_SOURCE_CODE_URL=https://github.com/your-org/undercover-chazzy/tree/{full-sha}
NEXT_PUBLIC_SOURCE_REVISION={full-sha}
COLLECTOR_ONLY_MODE=1
COLLECTOR_PROXY_ENABLED=1
COLLECTOR_PUBLIC_ORIGIN=https://collector.example.com
```

- `NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL`: 운영 collector와 같은 HTTPS origin을 사용합니다. 내장 proxy는 허용된 YouTube session/player/next/live-chat 경로만 전달합니다.
- `NEXT_PUBLIC_COLLECTOR_BRIDGE_DEBUG`: 로컬 진단 전용입니다. 운영에서는 반드시 `0`이어야 합니다. `1`이면 query bootstrap과 browser custom event mirror가 활성화됩니다.
- `NEXT_PUBLIC_SOURCE_CODE_URL`·`NEXT_PUBLIC_SOURCE_REVISION`: 실제 실행 revision의 변경분과 build 자료가 공개된 불변 URL과 40자 SHA입니다. mutable branch나 upstream 원본 URL은 readiness를 통과하지 않습니다.
- `COLLECTOR_ONLY_MODE`: 운영에서는 `1`로 설정해 원본 overlay route를 차단합니다.
- `COLLECTOR_PROXY_ENABLED`: 내장 InnerTube proxy kill switch입니다. 정확히 `1`일 때만 route가 열립니다.
- `COLLECTOR_PUBLIC_ORIGIN`: 배포된 collector의 정확한 HTTPS origin입니다. proxy build 값과 다르면 readiness가 실패합니다.

## 개발과 검증

Node.js 20과 pnpm을 사용합니다.

```bash
pnpm install
pnpm run test:collector
pnpm run lint:collector
pnpm exec tsc --noEmit
pnpm run build
```

collector 변경 파일은 `pnpm run lint:collector`로 검사합니다. 전체 `pnpm lint`에는 기준 커밋부터 존재한 `app/twitch/parser/parseMessage.mjs` 오류가 남아 있으므로, 그 기준선과 신규 오류를 구분해야 합니다.

디버그 bridge를 사용할 때만 유효한 임시 token과 run ID를 query로 줄 수 있습니다.

```text
http://localhost:3000/collector/youtube/{videoId}?bridgeToken={16자 이상}&collectorRunId={8자 이상}
```

이 방식은 `NEXT_PUBLIC_COLLECTOR_BRIDGE_DEBUG=1`인 빌드에서만 동작하며 운영 사용을 금지합니다.

## 보안 응답

collector 응답은 요청별 nonce CSP, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, 권한 차단 정책을 포함합니다. CSP의 `connect-src`는 collector origin과 설정한 proxy origin만 허용합니다. Sentry와 Vercel Analytics를 제거해 채팅 또는 bridge payload가 제3자 telemetry로 전송되지 않게 했습니다.

내장 proxy는 `/sw.js_data`, `/youtubei/v1/player`, `/youtubei/v1/next`, 두 live-chat continuation route만 허용합니다. 1MB request·8MB response·12초 timeout을 적용하고 cookie·authorization·응답 `set-cookie`를 전달하지 않습니다. `COLLECTOR_PROXY_ENABLED`가 꺼져 있거나 collector marker header가 없으면 404로 닫힙니다. 범용 URL proxy로 동작하지 않습니다.

## 컨테이너 배포 준비

`Dockerfile`은 Next standalone image를 만들고 `/collector/health`를 health check로 사용합니다. 아직 staging 앱 이름이 확정되지 않았으므로 실제 앱을 가리키는 설정은 만들지 않았고, `deploy/fly.collector.toml.example`만 제공합니다.

배포 전 순서는 다음과 같습니다.

1. 이 수정 fork를 공개 저장소에 push하고 배포할 40자 commit SHA를 고정합니다.
2. example TOML을 복사해 staging 앱 이름, collector origin, 불변 source URL을 같은 값으로 바꿉니다.
3. image를 빌드한 뒤 `/collector/health`가 `200 ready`인지 확인합니다. 하나라도 빠지면 `503 not_ready`입니다.
4. Flutter에는 같은 origin을 `LIVE_CHAT_COLLECTOR_BASE_URL`과 `LIVE_CHAT_COLLECTOR_PROXY_ORIGIN` 두 값으로 넣습니다.
5. 종료된 replay가 아니라 진행 중인 공개 live로 iOS·Android 전경 수집을 검증합니다.

## 배포 전 필수 확인

- 내장 proxy의 운영 owner, SLO, rate alert를 확정합니다. kill switch는 `COLLECTOR_PROXY_ENABLED=0`입니다.
- Next.js는 2026-08 공식 보안 패치가 포함된 Maintenance LTS `15.5.24`에 고정합니다. 정기 보안 릴리스마다 지원 patch를 다시 검토합니다.
- Next.js 15.5.24의 고정 transitive dependency에는 `postcss`, `nanoid`, `@babel/core` 보안 패치 override를 적용합니다. Next.js patch 변경 시 override 필요성을 다시 검토합니다.
- `youtubei.js 17.2.0`을 정확 버전으로 고정합니다. 기준 Chazzy의 16.0.1은 2026-09 실제 fixture에서 최신 YouTube renderer 파싱 경고가 재현되어 올렸습니다.
- 공개 서비스라면 실행 중인 수정본의 전체 대응 소스를 사용자가 받을 수 있도록 같은 버전의 공개 source URL을 제공해야 합니다.
- Flutter WebView가 collector origin만 main frame으로 허용하고 외부 탐색·파일·다운로드·카메라·마이크를 차단하는지 별도 앱 테스트를 통과해야 합니다.
- 실제 YouTube live fixture로 timestamp 단위, `error`/`end`, 방송 종료 상태를 확인해야 합니다.

## License

GNU Affero General Public License v3.0. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
