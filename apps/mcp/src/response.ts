export function ok(data: unknown, ms?: number) {
  const payload = ms != null ? { ...(data as Record<string, unknown>), _ms: ms } : data;
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export function err(tool: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: `${tool}: ${msg}` }], isError: true };
}
