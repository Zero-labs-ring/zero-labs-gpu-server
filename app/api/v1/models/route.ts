import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const models = [
    {
      id: 'titan-pro',
      name: 'Titan Pro 9B',
      object: 'model',
      created: 1715000000,
      owned_by: 'zerolabs',
      description: 'High-throughput dual-T4 Titan Pro 9B model with MTP acceleration (64 max batch).',
      context_window: 118000,
      tier: 'standard',
    },
    {
      id: 'pro',
      name: 'Titan Pro 9B (Short Alias)',
      object: 'model',
      created: 1715000000,
      owned_by: 'zerolabs',
      description: 'Alias for Titan Pro 9B.',
      context_window: 118000,
      tier: 'standard',
    },
    {
      id: 'titan-ultra',
      name: 'Titan Ultra 27B',
      object: 'model',
      created: 1715000000,
      owned_by: 'zerolabs',
      description: 'Ultra-reasoning Titan Ultra 27B Q4_K_M model with dual-T4 GPU offloading.',
      context_window: 118000,
      tier: 'premium',
    },
    {
      id: 'ultra',
      name: 'Titan Ultra 27B (Short Alias)',
      object: 'model',
      created: 1715000000,
      owned_by: 'zerolabs',
      description: 'Alias for Titan Ultra 27B.',
      context_window: 118000,
      tier: 'premium',
    },
    {
      id: 'search-pro',
      name: 'Titan Pro + Live Web Search',
      object: 'model',
      created: 1715000000,
      owned_by: 'zerolabs',
      description: 'Titan Pro augmented with live real-time internet search context and citations.',
      context_window: 118000,
      tier: 'standard',
    },
    {
      id: 'search-ultra',
      name: 'Titan Ultra + Live Web Search',
      object: 'model',
      created: 1715000000,
      owned_by: 'zerolabs',
      description: 'Titan Ultra deep reasoning with real-time web search retrieval.',
      context_window: 118000,
      tier: 'premium',
    },
  ];

  return NextResponse.json({
    object: 'list',
    data: models,
  });
}
