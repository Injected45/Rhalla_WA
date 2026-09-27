import type { Page } from 'puppeteer';

// WhatsApp Web (~2026-09-18 build) added a memoize helper that throws
// "Data passed to getter must include an id property (it's how we memoize)
// but got undefined" whenever it's called during media send. wwjs's own
// send code triggers this — every media send since the WA Web push has
// failed at that exact getter.
//
// Rather than fight wwjs's message-shape (which is a moving target as WA Web
// keeps evolving), we neutralise the source: find the memoize helper by its
// unique error string, wrap it so undefined returns null instead of throwing.
// The memoize's purpose is caching model lookups by id — returning null for
// an undefined argument is what any well-behaved lookup would do anyway.

export interface MemoizePatchResult {
  patched: boolean;
  functionsPatched: number;
  scannedModules: number;
  error?: string;
}

// Unique substring from the error message the helper throws — used to find it.
const ERROR_SIGNATURE = "must include an id property";

export async function installMemoizePatch(pupPage: Page): Promise<MemoizePatchResult> {
  return pupPage.evaluate((sig: string) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = window as any;
    const result: MemoizePatchResult = { patched: false, functionsPatched: 0, scannedModules: 0 };

    // Idempotent — if we've already patched, don't do it again.
    if (w.__waMemoizePatched) {
      return { ...result, patched: true, functionsPatched: w.__waMemoizePatched };
    }

    const patchFn = (fn: any): any => {
      const wrapped = function (this: any, ...args: any[]) {
        try {
          return fn.apply(this, args);
        } catch (err: any) {
          const msg = String(err?.message || err || '');
          if (msg.includes(sig)) {
            // Silently return null — the memoize helper's job is to look up
            // a model by id. If the id is undefined, "no such model" (null)
            // is the correct answer, not throwing an error the caller
            // clearly isn't handling (which is why wwjs's send crashes).
            return null;
          }
          throw err;
        }
      };
      // Preserve any static props / prototype so downstream users of the fn
      // that read fn.someMethod still work.
      Object.setPrototypeOf(wrapped, fn);
      for (const k of Object.getOwnPropertyNames(fn)) {
        try {
          if (k !== 'length' && k !== 'name' && k !== 'prototype') {
            (wrapped as any)[k] = fn[k];
          }
        } catch {
          /* readonly — ignore */
        }
      }
      return wrapped;
    };

    // Reach webpack's module cache via chunk-push probe (same technique as
    // wa-chats-reflect.ts).
    let webpackRequire: any = null;
    try {
      const chunkKey = Object.keys(w).find((k) => /^webpackChunk/i.test(k));
      if (!chunkKey) return { ...result, error: 'no webpack chunk key on window' };
      const chunk = w[chunkKey];
      if (!Array.isArray(chunk) || typeof chunk.push !== 'function') {
        return { ...result, error: 'webpack chunk not pushable' };
      }
      const probeId = '__wa_probe_' + Math.floor(Math.random() * 1e9);
      chunk.push([[probeId], {}, (r: any) => (webpackRequire = r)]);
      if (!webpackRequire) return { ...result, error: 'webpack require not captured from probe' };
    } catch (e: any) {
      return { ...result, error: `probe failed: ${e?.message || e}` };
    }

    const cache = webpackRequire.c || webpackRequire.cache || {};
    const moduleIds = Object.keys(cache);
    result.scannedModules = moduleIds.length;

    // Walk every export in every loaded module. Any function whose source
    // string mentions our error signature is a memoize-thrower. Wrap it.
    for (const id of moduleIds) {
      const mod = cache[id]?.exports;
      if (!mod || typeof mod !== 'object') continue;
      for (const key of Object.keys(mod)) {
        let val: any;
        try { val = mod[key]; } catch { continue; }
        if (typeof val !== 'function') continue;
        let src: string;
        try { src = val.toString(); } catch { continue; }
        if (!src.includes(sig)) continue;
        // Found a matching function — wrap it in place.
        try {
          mod[key] = patchFn(val);
          result.functionsPatched++;
        } catch {
          /* property may be readonly; skip */
        }
      }
    }

    w.__waMemoizePatched = result.functionsPatched;
    result.patched = result.functionsPatched > 0;
    return result;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, ERROR_SIGNATURE) as Promise<MemoizePatchResult>;
}
