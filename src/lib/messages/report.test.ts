import { afterEach, describe, expect, it } from "vitest";
import { reportError } from "./report";
import { getDefaultMessageStore } from "./default-message-store";

describe("reportError", () => {
  afterEach(() => {
    const store = getDefaultMessageStore();
    for (const message of store.state.messages) {
      store.dismiss(message.id);
    }
  });

  it("pushes the described error at error severity", () => {
    reportError(new Error("could not rename branch"));

    const messages = getDefaultMessageStore().state.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      severity: "error",
      text: "could not rename branch",
    });
  });
});
