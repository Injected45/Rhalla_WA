import type { Page } from 'puppeteer';

// wwjs's own client.getChats() / client.getChatById() call
// `window.require('WAWebCollections').Chat.getModelsArray()` inside the WA Web
// browser tab. When WA Web renames that module (as happened around 2026-08),
// wwjs throws an opaque minified error ("r: r") and every enumeration feature
// (groups list, contacts list, per-chat lookup) dies.
//
// This helper reaches into the same browser tab through a different door:
// it tries several strategies to find the Chat collection by SHAPE rather
// than by hardcoded name, then serialises the group chats we need.

export interface ReflectedChat {
  id: string;
  name: string | null;
  isGroup: boolean;
  description?: string;
  participants: Array<{
    id: string;
    isAdmin: boolean;
    isSuperAdmin: boolean;
  }>;
  ownerId?: string;
  createdAt?: number;
}

export interface ReflectionDiag {
  source: string | null;
  attempted: string[];
  errors: Record<string, string>;
  moduleCount?: number;
  chunkKeys?: string[];
}

export interface ReflectionResult {
  chats: ReflectedChat[] | null;
  diag: ReflectionDiag;
}

export async function reflectChatsFromWAWeb(pupPage: Page): Promise<ReflectionResult> {
  return pupPage.evaluate(() => {
    const diag: ReflectionDiag = { source: null, attempted: [], errors: {} };
    const w = window as any;

    // -------- serialiser: raw WA Chat model → our ReflectedChat --------
    const serialize = (c: any): ReflectedChat => {
      const meta = c.groupMetadata;
      const id = String(c.id?._serialized ?? c.id ?? '');
      // WA Web's Chat models have moved the `isGroup` boolean between builds.
      // Detect via any signal we can get: the flag if present, the JID server
      // suffix, or the presence of groupMetadata (only groups have one).
      const isGroup =
        Boolean(c.isGroup) ||
        (typeof c.id?.server === 'string' && c.id.server === 'g.us') ||
        id.endsWith('@g.us') ||
        !!meta;
      let participants: ReflectedChat['participants'] = [];
      try {
        const arr = meta?.participants?.getModelsArray?.();
        if (Array.isArray(arr)) {
          participants = arr.map((p: any) => ({
            id: String(p.id?._serialized ?? p.id ?? ''),
            isAdmin: Boolean(p.isAdmin),
            isSuperAdmin: Boolean(p.isSuperAdmin),
          }));
        }
      } catch {
        // participants may not be loaded — leave empty
      }
      return {
        id,
        // Try every field WA Web has ever exposed the human-readable name on.
        name:
          c.name ||
          c.formattedTitle ||
          c.contact?.pushname ||
          c.contact?.name ||
          meta?.subject ||
          meta?.subjectOwnerJid ||
          null,
        isGroup,
        description: meta?.desc || undefined,
        participants,
        ownerId: meta?.owner?._serialized ? String(meta.owner._serialized) : undefined,
        createdAt: typeof meta?.creation === 'number' ? meta.creation : undefined,
      };
    };

    // -------- Strategy 1: wwjs's original name --------
    try {
      const m = w.require?.('WAWebCollections');
      if (m?.Chat?.getModelsArray) {
        const arr = m.Chat.getModelsArray();
        return { chats: arr.map(serialize), diag: { ...diag, source: 'WAWebCollections' } };
      }
      diag.attempted.push('WAWebCollections:no-shape');
    } catch (e: any) {
      diag.errors['WAWebCollections'] = String(e?.message || e).slice(0, 200);
    }

    // -------- Strategy 2: alternative names WA has used or may use --------
    const nameCandidates = [
      'WAWebChat',
      'WAWebChatCollection',
      'WAWebChatCollectionData',
      'WAWebChatCollectionsData',
      'WAWebCollectionsData',
      'WAWebCollectionChat',
      'WAWebChatCollectionModel',
      'WAChatCollection',
      'WebChatCollection',
      'ChatCollection',
    ];
    for (const name of nameCandidates) {
      try {
        const m = w.require?.(name);
        if (!m) {
          diag.attempted.push(`${name}:undefined`);
          continue;
        }
        if (m.Chat?.getModelsArray) {
          const arr = m.Chat.getModelsArray();
          return { chats: arr.map(serialize), diag: { ...diag, source: name } };
        }
        if (m.getModelsArray) {
          const arr = m.getModelsArray();
          return { chats: arr.map(serialize), diag: { ...diag, source: `${name}.direct` } };
        }
        if (m.default?.Chat?.getModelsArray) {
          const arr = m.default.Chat.getModelsArray();
          return { chats: arr.map(serialize), diag: { ...diag, source: `${name}.default` } };
        }
        diag.attempted.push(`${name}:no-shape`);
      } catch (e: any) {
        diag.errors[name] = String(e?.message || e).slice(0, 200);
      }
    }

    // -------- Strategy 3: hunt the webpack module cache directly --------
    try {
      const chunkKeys = Object.keys(w).filter(k => /^webpackChunk/i.test(k));
      diag.chunkKeys = chunkKeys;
      for (const key of chunkKeys) {
        const chunk = w[key];
        if (!Array.isArray(chunk) || typeof chunk.push !== 'function') continue;
        let webpackRequire: any = null;
        const probeId = '__wa_probe_' + Math.floor(Math.random() * 1e9);
        try {
          chunk.push([
            [probeId],
            {},
            (r: any) => {
              webpackRequire = r;
            },
          ]);
        } catch {
          continue;
        }
        if (!webpackRequire) continue;
        const cache = webpackRequire.c || webpackRequire.cache || {};
        const ids = Object.keys(cache);
        diag.moduleCount = ids.length;
        for (const id of ids) {
          try {
            const mod = cache[id]?.exports;
            if (!mod) continue;
            if (mod.Chat?.getModelsArray) {
              const arr = mod.Chat.getModelsArray();
              return { chats: arr.map(serialize), diag: { ...diag, source: `webpack:${id}` } };
            }
            if (mod.default?.Chat?.getModelsArray) {
              const arr = mod.default.Chat.getModelsArray();
              return { chats: arr.map(serialize), diag: { ...diag, source: `webpack:${id}.default` } };
            }
          } catch {
            // one bad module shouldn't kill the scan
          }
        }
      }
    } catch (e: any) {
      diag.errors['webpackScan'] = String(e?.message || e).slice(0, 200);
    }

    return { chats: null, diag };
  });
}
