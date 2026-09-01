'use client';

import { default as NextError } from 'next/error';

export default function GlobalError() {
  return (
    <html>
      <body>
        <NextError statusCode={500} />
      </body>
    </html>
  );
}
