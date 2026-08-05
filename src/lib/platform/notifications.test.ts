import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const {
  getNotificationsPermission,
  onNotificationEvent,
  requestNotificationsPermission,
  showNotification,
} = await import("./notifications");

describe("native notification adapter", () => {
  it("preserves show and permission contracts", async () => {
    const userInfo = { type: "pr-comment", pull_request_number: 42 };
    invoke.mockResolvedValueOnce("17").mockResolvedValueOnce("default").mockResolvedValueOnce(true);

    await expect(showNotification("Review", "A comment arrived", userInfo)).resolves.toBe("17");
    await expect(getNotificationsPermission()).resolves.toBe("default");
    await expect(requestNotificationsPermission()).resolves.toBe(true);

    expect(invoke).toHaveBeenNthCalledWith(1, "show_notification", {
      title: "Review",
      body: "A comment arrived",
      userInfo,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "get_notifications_permission");
    expect(invoke).toHaveBeenNthCalledWith(3, "request_notifications_permission");
  });

  it("validates click payloads and returns listener cleanup", async () => {
    const unlisten = vi.fn();
    let nativeListener: ((event: { payload: unknown }) => void) | undefined;
    listen.mockImplementation(async (_name, callback) => {
      nativeListener = callback;
      return unlisten;
    });
    const callback = vi.fn();

    const cleanup = await onNotificationEvent(callback);
    nativeListener?.({
      payload: { event: "click", id: "9", userInfo: { saved: true } },
    });
    nativeListener?.({ payload: { event: "close", id: "9" } });
    nativeListener?.({ payload: { event: "click", id: 9 } });
    cleanup();

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith("click", "9", { saved: true });
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
