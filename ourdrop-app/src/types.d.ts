export {};

declare global {
  interface Window {
    odDesktop?: {
      isDesktop: boolean;
      pickPaths: () => Promise<{ path: string; name: string; size: number }[]>;
      getPathForFile: (file: File) => string;
      pickFolder: () => Promise<{ path?: string; warning?: string | null; error?: string } | null>;
      getSettings: () => Promise<{ folder: string; shared_dir: string | null }>;
      openFolder: () => Promise<void>;
      showInFolder: (name: string) => Promise<void>;
      getAppSettings: () => Promise<{ minimizeToTray: boolean; startWithWindows: boolean }>;
      setAppSetting: (key: string, value: boolean) => Promise<void>;
      previewFile: (name: string) => Promise<string>;
      onUpdateAvailable?: (cb: (info: { name: string; notes: string; current: string }) => void) => void;
      updateAction?: (action: string) => void;
      /** v56: PC in-app update download progress ({percent} 0..100, -1 = indeterminate) or {error:true}. */
      onUpdateProgress?: (cb: (s: { percent?: number; error?: boolean }) => void) => void;
      openExternal?: (url: string) => void;
      checkUpdate?: () => void;
      onUpdateResult?: (cb: (r: { status: string }) => void) => void;
    };
    OurDropAndroid?: {
      getReceiveProgress?: () => string;
      previewFile?: (name: string) => string;
      isDownloaded: (name: string, size: number) => boolean;
      openDownloads: () => void;
      isBatteryExempt?: () => boolean;
      openBatterySettings?: () => void;
      openExternal?: (url: string) => void;
      updateDisplayed?: () => void;
      checkForUpdate?: () => void;
      /** v48: cancel a live auto-download from the transfer card. */
      cancelReceive?: (name: string) => void;
      /** v50: manual download from the Files list, run natively. */
      downloadFile?: (name: string) => void;
      /** v54: open the native (dismissible) connect flow from the dashboard. */
      openConnectFlow?: () => void;
      /** v56: download the update APK natively (DownloadManager) and open the install prompt when it lands. */
      downloadUpdate?: (url: string) => void;
    };
    __odReceived?: (name: string) => void;
    __odDlEvent?: (name: string, ok: boolean, err?: string) => void;
    __odUpdate?: (info: { name: string; notes: string; current: string; apk: string }) => void;
    __odUpdateResult?: (status: string) => void;
  }
}
