import type { Page } from 'puppeteer';

// wwjs's Client.sendMessage(chatId, MessageMedia, ...) went from working to
// throwing "Data passed to getter must include an id property (it's how we
// memoize) but got undefined" between 2026-09-17 and 2026-09-19 — WhatsApp
// Web pushed a new build that added a memoize step wwjs's message object
// doesn't populate. Text sends still work; every media send throws.
//
// This helper mirrors wwjs's WWebJS.sendMessage flow, but stops before the
// step that throws: after `addAndSendMsgToChat` returns we build our own
// result and skip WWebJS.getMessageModel (which internally calls
// msg.serialize() → the failing WA Web memoize getter). The message goes out;
// we just can't correlate a WA-side message id back — the caller already
// handles the "delivered without id" case gracefully.

export interface MediaSendInput {
  chatId: string;
  base64: string; // raw base64, no data: prefix
  mimetype: string;
  filename?: string;
  caption?: string;
}

export interface MediaSendResult {
  ok: boolean;
  step?: string; // where it failed if ok=false
  error?: string;
  id?: string; // serialized message key when ok=true
  timestamp?: number;
}

export async function sendMediaViaWAWeb(pupPage: Page, input: MediaSendInput): Promise<MediaSendResult> {
  return pupPage.evaluate(async (opts: MediaSendInput) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const step = (name: string, err: unknown): MediaSendResult => ({
      ok: false,
      step: name,
      error: String((err as Error)?.stack || (err as Error)?.message || err).slice(0, 800),
    });

    const w = window as any;
    let chat: any;
    let mediaData: any;
    let newMsgKey: any;
    let t: number;

    // Step 1: resolve the chat
    try {
      if (!w.WWebJS?.getChat) return step('bootstrap', 'window.WWebJS.getChat missing');
      chat = await w.WWebJS.getChat(opts.chatId, { getAsModel: false });
      if (!chat) return step('getChat', `chat not found for ${opts.chatId}`);
    } catch (e) {
      return step('getChat', e);
    }

    // Step 2: build MessageMedia-shaped object and upload via wwjs's own path
    try {
      if (!w.WWebJS.processMediaData) return step('bootstrap', 'window.WWebJS.processMediaData missing');
      const mediaInfo = {
        mimetype: opts.mimetype,
        data: opts.base64,
        filename: opts.filename,
        filesize: undefined,
      };
      mediaData = await w.WWebJS.processMediaData(mediaInfo, {
        forceSticker: false,
        forceGif: false,
        forceVoice: false,
        forceDocument: false,
        forceMediaHd: false,
        sendToChannel: false,
        sendToStatus: false,
      });
    } catch (e) {
      return step('processMediaData', e);
    }

    // Step 3: build the msg key + message object (mirrors wwjs Utils.js:419-484)
    let from: any;
    try {
      const { getMaybeMeLidUser, getMaybeMePnUser } = w.require('WAWebUserPrefsMeUser');
      const lidUser = getMaybeMeLidUser();
      const meUser = getMaybeMePnUser();
      const newId = await w.require('WAWebMsgKey').newId();
      from = chat.id?.isLid?.() ? lidUser : meUser;
      if (!from) return step('resolveFrom', 'meUser/lidUser returned undefined');
      // WA Web's new getSender walks msg.participant, so for 1:1 sends we
      // still set it (wwjs leaves it undefined for 1:1) to a valid Wid.
      newMsgKey = new (w.require('WAWebMsgKey'))({
        from,
        to: chat.id,
        id: newId,
        participant: from,
        selfDir: 'out',
      });
      t = Math.floor(Date.now() / 1000);
      const ephemeralFields = w
        .require('WAWebGetEphemeralFieldsMsgActionsUtils')
        .getEphemeralFields(chat);

      // Fix per wwjs upstream issue #201923: MediaData's private MobX
      // property `__x_id` gets copied by spread, colliding with the
      // message's real `id: newMsgKey`. WA Web's new memoize helper reads
      // that `__x_id` (undefined shape for our new msg), calls getModel,
      // and throws. Deleting it before the spread lets the proper
      // `id: newMsgKey` survive intact.
      const mediaOptions: any = mediaData;
      mediaOptions.caption = opts.caption;
      try {
        delete mediaOptions.__x_id;
      } catch {
        /* readonly getter — best-effort */
      }
      const content: any = mediaOptions?.preview;
      const message: any = {
        id: newMsgKey,
        ack: 0,
        body: content,
        from,
        to: chat.id,
        local: true,
        self: 'out',
        t,
        isNewMsg: true,
        type: 'chat',
        ...ephemeralFields,
        ...mediaOptions,
        ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),
      };
      // Restore proper id and set author AFTER the spread — belt-and-
      // suspenders against any MobX private that slipped in through the
      // spread despite the __x_id delete above.
      message.id = newMsgKey;
      message.author = from;

      // Step 4: dispatch via WA Web's own send action
      const sendMod = w.require('WAWebSendMsgChatAction');
      if (!sendMod?.addAndSendMsgToChat) return step('sendModule', 'WAWebSendMsgChatAction.addAndSendMsgToChat missing');
      // Verify the critical media fields survived our clean-primitives pick
      // (a missing one silently makes WA server reject the wire ack even
      // though the local msgPromise resolves — which is what happened on
      // 2026-09-19: docs looked SENT locally but never reached recipients).
      const missing = ['mimetype', 'mediaKey', 'directPath', 'filehash', 'encFilehash']
        .filter((k) => message[k] == null);
      if (missing.length) {
        return step('preflightMedia', `media fields missing: ${missing.join(',')}`);
      }
      try {
        const [msgPromise, sendPromise] = sendMod.addAndSendMsgToChat(chat, message);
        await msgPromise;
        // AWAIT the wire ack. addAndSendMsgToChat's second promise resolves
        // when WA server accepts the send. If we don't wait on this, docs
        // can look SENT locally but the wire never carries them — that's the
        // exact "text arrived, doc didn't" symptom.
        try {
          await sendPromise;
        } catch (ackErr) {
          const summary = {
            err: String((ackErr as Error)?.message || ackErr).slice(0, 400),
            msgType: message.type,
            hasMediaKey: !!message.mediaKey,
            hasDirectPath: !!message.directPath,
            hasFilehash: !!message.filehash,
            hasEncFilehash: !!message.encFilehash,
            mimetype: message.mimetype,
            size: message.size,
          };
          return step('wireAck', `WA rejected send: ${JSON.stringify(summary)}`);
        }
      } catch (innerErr) {
        const summary = {
          err: String((innerErr as Error)?.message || innerErr).slice(0, 300),
          msgKeys: Object.keys(message).filter((k) => !k.startsWith('__')).sort(),
          hasFrom: !!message.from,
          hasTo: !!message.to,
          hasAuthor: !!message.author,
          hasId: !!message.id,
          mediaType: message.type,
        };
        return step('send', `${summary.err} :: shape=${JSON.stringify(summary)}`);
      }
    } catch (e) {
      return step('build', e);
    }

    // Success. We deliberately skip WWebJS.getMessageModel because on the
    // 2026-09 WA Web build it internally calls Msg.serialize → the memoize
    // getter that throws. The message has already been dispatched by
    // addAndSendMsgToChat before we would call getMessageModel.
    try {
      return {
        ok: true,
        id: String(newMsgKey?._serialized ?? ''),
        timestamp: t,
      };
    } catch (e) {
      return step('serializeKey', e);
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, input);
}
