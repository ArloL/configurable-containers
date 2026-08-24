// The protocol between the background `pause` module and the options page. Pure — no
// browser, no DOM — like picker-protocol.ts.
//
// Unlike the choice page, this protocol DOES name a container, because the sender is the
// options tab, not the tab under discussion, so there is nothing to derive it from. The
// background therefore VALIDATES the cookieStoreId — a real identity, never the default
// container — instead of trusting it.

import type { Recording } from "../engine/pause";

export interface PauseStatusMessage {
  type: "cc-pause-status";
}

export interface PauseToggleMessage {
  type: "cc-pause-toggle";
  cookieStoreId: string;
}

export interface PauseClearMessage {
  type: "cc-pause-clear";
}

export interface ContainerRow {
  cookieStoreId: string;
  name: string;
  tabCount: number;
  // The hosts of that container's open tabs. Not decoration: "tmp3 / tmp8 / tmp12" says
  // nothing about which one holds the checkout the user is trying to protect.
  hosts: string[];
  armed: boolean;
  armable: boolean;
  reason?: string; // why not, when armable is false
}

export interface PauseStatusResponse {
  containers: ContainerRow[];
  recordings: Recording[];
}

export interface PauseToggleResponse {
  ok: boolean;
  message: string;
}
