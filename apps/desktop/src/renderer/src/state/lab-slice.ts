import {
  loginItemCheck, touchIdCheck,
  type LabAccount, type LabCheck, type LabDeviceKind, type LabDevices, type LabReadiness, type LabSettingsPane, type LabStatus,
  type UnlockPolicyStatus,
} from "@realm/contracts";

export type LabLoginItem = { openAtLogin: boolean | null; canSet: boolean };
export type LabDeviceInput = { kind: LabDeviceKind; udid: string | null; name: string; spaceId: string | null; accounts: LabAccount[] };
export type LabDevicePatch = { id: string; name?: string; spaceId?: string | null; accounts?: LabAccount[] };

/** The lab calls the renderer makes: `lab.*` on the server, and main's login item and panes. */
export type LabApi = {
  labStatus(): Promise<LabStatus>;
  labSetEnabled(enabled: boolean): Promise<LabStatus>;
  labSetUpdateWindow(hour: number, capMinutes: number): Promise<LabStatus>;
  labUpdateNow(): Promise<LabStatus>;
  labReadiness(): Promise<LabReadiness>;
  labDevices(): Promise<LabDevices>;
  labScan(): Promise<LabDevices>;
  labDeviceAdd(input: LabDeviceInput): Promise<LabDevices>;
  labDeviceUpdate(patch: LabDevicePatch): Promise<LabDevices>;
  labDeviceRemove(id: string): Promise<LabDevices>;
  /** Null where there is no main to ask (tests, a browser). */
  labLoginItem(): Promise<LabLoginItem | null>;
  labSetLoginItem(on: boolean): Promise<LabLoginItem | null>;
  labOpenSettings(pane: LabSettingsPane): Promise<void>;
  onLabChanged(cb: () => void): () => void;
};

/** What the slice reads from the rest of the store's API: the unlock policy and the sensor (#134). */
type CredentialApi = {
  credentialStatus(): Promise<{ canPromptTouchID: boolean; canPromptDeviceOwner: boolean }>;
  credentialUnlockPolicy(profileId: string): Promise<UnlockPolicyStatus | null>;
};

/**
 * Settings ▸ Lab. `labChecks` is the checklist in page order: the server's probes of the Mac, then the
 * two only this window can answer — the profile's unlock against the sensor, and Realm's login item.
 * Nothing is held until the page is opened, and the page re-reads on `lab.changed`.
 */
export type LabSlice = {
  lab: LabStatus | null;
  labChecks: LabCheck[] | null;
  labCheckedAt: number | null;
  labChecking: boolean;
  labDevices: LabDevices | null;
  labLoginItem: LabLoginItem | null;
  labScanning: boolean;

  loadLab(): Promise<void>;
  checkLab(): Promise<void>;
  setLabEnabled(enabled: boolean): Promise<void>;
  setLabUpdateWindow(hour: number, capMinutes: number): Promise<void>;
  labUpdateNow(): Promise<void>;
  scanLabDevices(): Promise<void>;
  addLabDevice(input: LabDeviceInput): Promise<void>;
  updateLabDevice(patch: LabDevicePatch): Promise<void>;
  removeLabDevice(id: string): Promise<void>;
  setLabLoginItem(on: boolean): Promise<void>;
  openLabSettings(pane: LabSettingsPane): Promise<void>;
  watchLab(): () => void;
};

type Host = { activeProfileId: string | null; profiles: readonly { id: string; name: string }[] };

export function labSlice<S extends Host & LabSlice>(
  api: LabApi & CredentialApi,
  get: () => S,
  set: (partial: Partial<LabSlice>) => void,
): LabSlice {
  /** The two checks this window answers, from main's facts. */
  const localChecks = async (): Promise<{ checks: LabCheck[]; loginItem: LabLoginItem | null }> => {
    const pid = get().activeProfileId;
    const profileName = get().profiles.find((p) => p.id === pid)?.name ?? "This profile";
    const [cred, policy, loginItem] = await Promise.all([
      api.credentialStatus().catch(() => null),
      pid ? api.credentialUnlockPolicy(pid).catch(() => null) : Promise.resolve(null),
      api.labLoginItem().catch(() => null),
    ]);
    return {
      loginItem,
      checks: [
        touchIdCheck({ policy: policy?.policy ?? null, canPromptTouchID: cred?.canPromptTouchID ?? false, canPromptDeviceOwner: cred?.canPromptDeviceOwner ?? false, profileName }),
        loginItemCheck({ openAtLogin: loginItem?.openAtLogin ?? null, canSet: loginItem?.canSet ?? false }),
      ],
    };
  };

  return {
    lab: null, labChecks: null, labCheckedAt: null, labChecking: false, labDevices: null, labLoginItem: null, labScanning: false,

    async loadLab() {
      const [lab, labDevices] = await Promise.all([api.labStatus(), api.labDevices()]);
      set({ lab, labDevices });
    },
    async checkLab() {
      set({ labChecking: true });
      try {
        const [server, local] = await Promise.all([api.labReadiness(), localChecks()]);
        set({ labChecks: [...server.checks, ...local.checks], labCheckedAt: server.checkedAt, labLoginItem: local.loginItem });
      } finally { set({ labChecking: false }); }
    },
    async setLabEnabled(enabled) { set({ lab: await api.labSetEnabled(enabled) }); },
    async setLabUpdateWindow(hour, capMinutes) { set({ lab: await api.labSetUpdateWindow(hour, capMinutes) }); },
    async labUpdateNow() { set({ lab: await api.labUpdateNow() }); },
    async scanLabDevices() {
      set({ labScanning: true });
      try { set({ labDevices: await api.labScan() }); } finally { set({ labScanning: false }); }
    },
    async addLabDevice(input) { set({ labDevices: await api.labDeviceAdd(input) }); },
    async updateLabDevice(patch) { set({ labDevices: await api.labDeviceUpdate(patch) }); },
    async removeLabDevice(id) { set({ labDevices: await api.labDeviceRemove(id) }); },
    async setLabLoginItem(on) {
      const loginItem = await api.labSetLoginItem(on);
      const checks = get().labChecks;
      set({
        labLoginItem: loginItem,
        // The one row it changes, re-judged from what macOS now reports.
        ...(checks ? { labChecks: checks.map((c) => (c.id === "login-item" ? loginItemCheck({ openAtLogin: loginItem?.openAtLogin ?? null, canSet: loginItem?.canSet ?? false }) : c)) } : {}),
      });
    },
    openLabSettings: (pane) => api.labOpenSettings(pane),
    watchLab() {
      return api.onLabChanged(() => {
        // Status and devices only: the checklist probes the Mac, which nothing here changed.
        if (get().lab) void get().loadLab().catch(() => undefined);
      });
    },
  };
}
