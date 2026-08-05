export interface DialogFilter {
  readonly name: string;
  readonly extensions: ReadonlyArray<string>;
}

export type OpenDialogProperty =
  | "openFile"
  | "openDirectory"
  | "multiSelections"
  | "showHiddenFiles"
  | "createDirectory"
  | "promptToCreate"
  | "noResolveAliases"
  | "treatPackageAsDirectory"
  | "dontAddToRecent";

interface DialogOptions {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly filters?: ReadonlyArray<DialogFilter>;
}

export interface OpenDialogOptions extends DialogOptions {
  readonly buttonLabel?: string;
  readonly message?: string;
  readonly properties?: ReadonlyArray<OpenDialogProperty>;
}

export interface SaveDialogOptions extends DialogOptions {
  readonly buttonLabel?: string;
  readonly message?: string;
  readonly nameFieldLabel?: string;
  readonly showsTagField?: boolean;
  readonly properties?: ReadonlyArray<"createDirectory" | "showHiddenFiles">;
}
