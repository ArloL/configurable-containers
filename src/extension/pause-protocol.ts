// The shared protocol between the background `pause` module and the options page. Pure,
// no browser, no DOM — so the shapes stay unit-testable, exactly like picker-protocol.ts.
//
// Unlike the choice page, this protocol DOES name a container. It has to: the sender is
// the options tab, and that is not the tab under discussion, so there is nothing to
// derive the container from. The background therefore VALIDATES the cookieStoreId
// (a real identity, and never the default container) instead of trusting it.

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
  // The hosts of that container's open tabs. Not decoration: a list reading
  // "tmp3 / tmp8 / tmp12" says nothing about which one is holding the checkout the user
  // is trying to protect, and is unusable at the one moment this is reached for.
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
