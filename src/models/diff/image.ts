/**
 * An image in a diff.
 *
 * # A URL, where upstream carried base64
 *
 * The original held the image twice — an `ArrayBuffer` and a base64 string — and the diff payload carried
 * both through IPC. A 4 MB PNG therefore became ~5.5 MB of JSON, copied twice, resident for as long as the
 * diff was open. This carries a URL the webview fetches instead, so the bytes never enter JavaScript unless
 * something asks for them, and `<img src>` asks natively.
 *
 * The one consumer that genuinely needs bytes — the DirectDraw Surface converter — fetches the URL for them,
 * which costs an `await` in a branch that already did work per image.
 */
export class Image {
  /**
   * @param url The `rdc-blob://` URL serving the image's bytes. Rust mints it, because its shape depends on
   *            the platform the webview runs on.
   * @param mediaType The media type, so the viewer can tell a renderable image from one it must convert.
   * @param bytes Size of the file in bytes. Shown per side, and as the difference between them.
   */
  public constructor(
    public readonly url: string,
    public readonly mediaType: string,
    public readonly bytes: number
  ) {}
}
