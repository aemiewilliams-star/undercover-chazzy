import './globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <head>
        <title>UNDERCOVER Live Chat Collector</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
