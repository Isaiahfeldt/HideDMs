// HideDMs — Vencord user plugin
// NOTE: This user plugin aims to hide selected DMs from the UI, persist them across restarts,
// add Hide/Unhide to DM context menus, and provide a secret reveal toggle (Ctrl+Shift+K).
// It follows common Vencord plugin patterns used by official/community plugins like PinDMs.

import { React } from "@webpack/common";
import { Menu } from "@webpack/common";
import { Settings, definePluginSettings } from "@api/Settings";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";

import { FluxDispatcher } from "@webpack/common";
import definePlugin, { OptionType } from "@utils/types";

const PLUGIN_ID = "HideDMs";
const STORAGE_KEY = "hiddenList"; // CSV string of channel IDs

// Optional, user-facing toggles (kept minimal). The hidden list itself is stored directly in Settings.
export const settings = definePluginSettings({
    revealKey: {
        description: "Reveal hotkey (used with Ctrl+Shift+<key>)",
        default: "K",
        type: OptionType.STRING
    },
});

// Module-level state and helpers to avoid relying on `this` inside closures
let hiddenSet = new Set<string>();
let reveal = false;

const isHiddenLocal = (id: string): boolean => {
    if (!id) return false;
    return !reveal && hiddenSet.has(String(id));
};

function hideLocal(id: string) {
    if (!id) return;
    hiddenSet.add(String(id));
    saveHiddenSet(hiddenSet);
    rebuildHiddenStyles();
    forceRefresh();
}

function unhideLocal(id: string) {
    if (!id) return;
    hiddenSet.delete(String(id));
    saveHiddenSet(hiddenSet);
    rebuildHiddenStyles();
    forceRefresh();
}

function toggleRevealLocal(value?: boolean) {
    reveal = value ?? !reveal;
    rebuildHiddenStyles();
    forceRefresh();
}

function getHiddenSet(): Set<string> {
    const s = (Settings.plugins as any)?.[PLUGIN_ID]?.[STORAGE_KEY] as string | undefined;
    if (!s) return new Set();
    return new Set(s.split(",").map(v => v.trim()).filter(Boolean));
}

function saveHiddenSet(set: Set<string>) {
    const arr = Array.from(set);
    const csv = arr.join(",");
    if (!(Settings.plugins as any)[PLUGIN_ID]) (Settings.plugins as any)[PLUGIN_ID] = {};
    (Settings.plugins as any)[PLUGIN_ID][STORAGE_KEY] = csv;
}

function forceRefresh() {
    // Nudge stores/UI to recalc. This is intentionally generic.
    try {
        FluxDispatcher?.dispatch?.({ type: "HIDE_DMS_REFRESH_TICK" });
    } catch {}
}

let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

// Track whether Shift was held when the most recent context menu was opened
let lastContextMenuShift = false;
let lastContextMenuTime = 0;
let contextMenuHandler: ((e: MouseEvent) => void) | null = null;

function shouldShowShiftMenuItem(): boolean {
    return lastContextMenuShift && Date.now() - lastContextMenuTime < 2000;
}

let styleEl: HTMLStyleElement | null = null;
function ensureStyleEl(): HTMLStyleElement {
    if (styleEl && document.head.contains(styleEl)) return styleEl;
    styleEl = document.createElement("style");
    styleEl.id = "vc-hidedms-style";
    document.head.appendChild(styleEl);
    return styleEl;
}

function cssEscape(s: string): string {
    try {
        const esc = (CSS as any)?.escape;
        return esc ? esc(String(s)) : String(s).replace(/[^a-zA-Z0-9_-]/g, c => "\\" + c);
    } catch {
        return String(s).replace(/"/g, '\\"');
    }
}

function rebuildHiddenStyles() {
    const el = ensureStyleEl();
    if (reveal || hiddenSet.size === 0) {
        el.textContent = "";
        return;
    }
    const selectors: string[] = [];
    hiddenSet.forEach(id => {
        const esc = cssEscape(String(id));
        const base1 = `[data-list-item-id^="private"][data-list-item-id*="${esc}"]`;
        const base2 = `[data-list-item-id^="private-channels"][data-list-item-id*="${esc}"]`;
        // Direct targets (some builds apply the attribute on the row itself)
        selectors.push(base1, base2);
        // Also remove the immediate wrapper elements that contain the row; this prevents hover UI (…)
        // from showing for hidden rows if Discord attaches hover handlers to the wrapper.
        selectors.push(`li:has(> ${base1})`, `li:has(> ${base2})`);
        selectors.push(`div:has(> ${base1})`, `div:has(> ${base2})`);
    });
    el.textContent = selectors.length ? `${selectors.join(",")} { display: none !important; pointer-events: none !important; }` : "";
}

export default definePlugin({
    name: PLUGIN_ID,
    description: "Shift right-click to hide specific DMs. Hidden DMs are removed from the UI and can be revealed with Ctrl+Shift+<key> (default K).",
    authors: [{ name: "November", id: 138148168360656896n }],

    contextMenus: {
        // Shift right-click on a user DM
        "user-context": ((children: any[], props: any) => {
            try {
                if (!shouldShowShiftMenuItem()) return children;
                const container = findGroupChildrenByChildId("close-dm", children);
                if (!container) return children;

                const channelId = props?.channel?.id ?? props?.privateChannel?.id ?? props?.targetChannel?.id ?? null;
                if (!channelId) return children;

                const isHidden = hiddenSet.has(String(channelId));

                const idx = container.findIndex((c: any) => c?.props?.id === "close-dm");
                const item = (
                    React.createElement(Menu.MenuItem, {
                        id: "hide-dm-toggle",
                        label: isHidden ? "Unhide DM" : "Hide DM",
                        action: () => {
                            if (isHidden) unhideLocal(channelId); else hideLocal(channelId);
                            forceRefresh();
                        }
                    })
                );
                if (idx >= 0) container.splice(idx, 0, item); else container.unshift(item);
            } catch {}
            return children;
        }) as unknown as NavContextMenuPatchCallback,

        // Shift right-click on a group DM
        "gdm-context": ((children: any[], props: any) => {
            try {
                if (!shouldShowShiftMenuItem()) return children;
                const container = findGroupChildrenByChildId("leave-channel", children);
                if (!container) return children;

                const channelId = props?.channel?.id ?? props?.targetChannel?.id ?? null;
                if (!channelId) return children;

                const isHidden = hiddenSet.has(String(channelId));

                const idx = container.findIndex((c: any) => c?.props?.id === "leave-channel");
                const item = (
                    React.createElement(Menu.MenuItem, {
                        id: "hide-gdm-toggle",
                        label: isHidden ? "Unhide DM" : "Hide DM",
                        action: () => {
                            if (isHidden) unhideLocal(channelId); else hideLocal(channelId);
                            forceRefresh();
                        }
                    })
                );
                if (idx >= 0) container.splice(idx, 0, item); else container.unshift(item);
            } catch {}
            return children;
        }) as unknown as NavContextMenuPatchCallback,
    },

    // Runtime helpers exposed to $self in patches
    isHidden(id: string): boolean {
        return isHiddenLocal(id);
    },

    hide(id: string) {
        hideLocal(id);
    },

    unhide(id: string) {
        unhideLocal(id);
    },

    toggleReveal(value?: boolean) {
        toggleRevealLocal(value);
    },

    // Lifecycle
    start() {
        hiddenSet = getHiddenSet();
        reveal = false;

        // Apply initial hidden CSS on startup so hidden DMs are hidden on first load
        rebuildHiddenStyles();
        forceRefresh();

        // Secret reveal: Ctrl+Shift+<key> (configurable; default K)
        keydownHandler = (ev: KeyboardEvent) => {
            const configured = String(settings.store?.revealKey ?? "K").trim();
            const target = configured.length > 0 ? configured : "K";
            const keyMatches = typeof ev.key === "string" && ev.key.toLowerCase() === target.toLowerCase();
            if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && keyMatches) {
                toggleRevealLocal();
            }
        };
        window.addEventListener("keydown", keydownHandler, true);

        // Track Shift state for context menu visibility of Hide/Unhide
        contextMenuHandler = (ev: MouseEvent) => {
            try {
                lastContextMenuShift = !!(ev as MouseEvent).shiftKey;
                lastContextMenuTime = Date.now();
            } catch {
                lastContextMenuShift = false;
                lastContextMenuTime = 0;
            }
        };
        window.addEventListener("contextmenu", contextMenuHandler, true);

        // Register dynamic patches (none here beyond static ones), placeholder for future.
    },

    stop() {
        try { window.removeEventListener("keydown", keydownHandler!, true); } catch {}
        keydownHandler = null;

        // Remove contextmenu listener and reset shift tracking
        try { if (contextMenuHandler) window.removeEventListener("contextmenu", contextMenuHandler, true); } catch {}
        contextMenuHandler = null;
        lastContextMenuShift = false;
        lastContextMenuTime = 0;

        // Remove injected styles on stop to avoid leftovers when disabling the plugin
        try {
            if (styleEl && styleEl.parentNode) {
                styleEl.parentNode.removeChild(styleEl);
            }
        } catch {}
        styleEl = null;
    },

    settings,
});
