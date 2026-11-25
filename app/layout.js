import './globals.css';

export const metadata = {
  title: 'CodeSync — collaborative coding rooms',
  description: 'Real-time collaborative coding with admin-controlled editing, live cursors and built-in code execution.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d1117',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
