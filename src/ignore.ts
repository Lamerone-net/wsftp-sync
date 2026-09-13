interface CompiledRegex {
  test(subject: string, options?: {matchLimit:number; depthLimit:number}): boolean;
  destroy(): void;
}
let engine: {compile(pattern:string, flags?:number):CompiledRegex} | undefined;
let flags: ((value:string) => number) | undefined;
let initialization: Promise<void> | undefined;
const cache = new Map<string,CompiledRegex>();

export function initializeRegex(): Promise<void> {
  return initialization ??= import('pcre2-wasm').then(async module => {
    engine = await module.createPCRE2();
    flags = module.parseFlags;
  });
}
export function isRegex(pattern:string): boolean { return pattern.startsWith('/'); }
export function normalizeIgnore(pattern:string): string {
  return isRegex(pattern) ? pattern : pattern.replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/$/,'');
}
export function compileIgnore(pattern:string): CompiledRegex {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const end = pattern.lastIndexOf('/');
  if (end <= 0) throw new Error('Expected /pattern/flags.');
  const modifiers = pattern.slice(end+1);
  if (!/^[imsxu]*$/.test(modifiers) || new Set(modifiers).size !== modifiers.length) throw new Error('Supported regex flags: i, m, s, x, u (without duplicates).');
  if (!engine || !flags) throw new Error('PCRE2 is not initialized.');
  const compiled = engine.compile(pattern.slice(1,end),flags(modifiers));
  if (cache.size >= 256) {
    const oldest = cache.keys().next().value!;
    cache.get(oldest)!.destroy();
    cache.delete(oldest);
  }
  cache.set(pattern,compiled);
  return compiled;
}
export function matchesRegex(pattern:string,subject:string): boolean {
  return compileIgnore(pattern).test(subject,{matchLimit:100000,depthLimit:500});
}
export function disposeRegex(): void {
  for (const regex of cache.values()) regex.destroy();
  cache.clear();
}
