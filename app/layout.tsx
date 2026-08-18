import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zero Labs — Unified Cloud & GPU Hub',
  description: 'High-Throughput Dual T4 GPU Clusters, OpenAI-Compatible API Gateway, and Search Engine',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
