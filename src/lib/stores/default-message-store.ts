import { MessageStore } from "./message-store";

let defaultStore: MessageStore | undefined;

/** One message owner per webview, so a toast from any store ends up in the same stack. */
export function getDefaultMessageStore(): MessageStore {
  defaultStore ??= new MessageStore();
  return defaultStore;
}
