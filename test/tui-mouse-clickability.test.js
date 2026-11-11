/**
 * test/tui-mouse-clickability.test.js
 *
 * Wave 6 Standalone Intercom TUI — Minimalist UX, SGR Mouse Clickability & Layout Suite.
 *
 * Verifies:
 * 1. SGR 1006 Extended Mouse Tracking startup/exit escapes & raw sequence decoding.
 * 2. Full Row-1 Top Bar (top-left sub-tabs, [ + New ], close ×, Tab key, top-right [ ☰ Menu ]).
 * 3. Eliminated fixed left-sidebar clutter by default & Centered `✉ Intercom` Composer.
 * 4. Collapsible RIGHT-side sidebar (hidden by default; right-aligned hitboxes when opened).
 * 5. Target Selector Dropdown (`To: [ @target ▾ ]`) & Live `/` Slash-Command Dropdown.
 * 6. Info [ ↻ Refresh ], Settings telemetry toggles & toggleable Lower-Corner Stats.
 * 7. Deep dark charcoal background palette (`48;5;234m` / `48;5;233m`) & Pure Messaging Invariant.
 */

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const tui = require("../bin/intercom-tui.js");

const TUI_PATH = path.resolve(__dirname, "..", "bin", "intercom-tui.js");
const stripAnsi = (str) => String(str || "").replace(/\x1b\[[0-9;]*m/g, "");

describe("Intercom Global TUI — Wave 6 Minimalist UX & Full Mouse Clickability Suite", () => {
  after(() => {
    tui.destroyScreen();
  });

  beforeEach(() => {
    tui.clearHitboxes();
    tui.setState({
      activeNav: 0,
      rightSidebarOpen: false,
      selectedType: "peer",
      selectedAgent: "jules",
      selectedChannel: "general",
      agentList: ["antigravity", "opencode", "jules", "sentinel", "coordinator"],
      channelList: ["general", "alerts", "handoffs"],
      agentIdx: 2,
      channelIdx: 0,
      subTabs: [{ id: "home", kind: "home", label: "✦ Home", closable: false }],
      activeSubTabIndex: 0,
      composerBuffer: "",
      composerFocused: true,
      targetDropdownOpen: false,
      targetDropdownIndex: 0,
      slashMenuDismissed: false,
      slashSelectedIndex: 0,
      settings: {
        showCornerStats: true,
        readReceipts: true,
        showTimestamps: true,
        darkTheme: true,
        sidebarDefaultOpen: false
      },
      selectedSettingIndex: 0,
      meshStats: { peers: 5, unread: 2, channels: 3, dlq: 0 }
    });
  });

  describe("1. SGR Mouse Protocol Initialization & Source Escapes", () => {
    it("Enables SGR 1006 extended mouse tracking on startup", () => {
      const src = fs.readFileSync(TUI_PATH, "utf8");
      assert.match(src, /\\x1b\[\?1000h/, "Must enable SGR basic mouse tracking");
      assert.match(src, /\\x1b\[\?1002h/, "Must enable cell motion mouse tracking");
      assert.match(src, /\\x1b\[\?1006h/, "Must enable SGR 1006 extended mouse coordinates");
    });

    it("Cleans up SGR mouse modes on exit", () => {
      const src = fs.readFileSync(TUI_PATH, "utf8");
      assert.match(src, /\\x1b\[\?1000l/);
      assert.match(src, /\\x1b\[\?1002l/);
      assert.match(src, /\\x1b\[\?1006l/);
    });

    it("Decodes raw SGR mouse sequences accurately via parseSgrSequence & sgrRegex", () => {
      const rawPress = "\x1b[<0;24;12M";
      const rawWheel = "\x1b[<64;40;15M";
      const rawRelease = "\x1b[<0;24;12m";

      const press = tui.parseSgrSequence(rawPress);
      assert.equal(press.length, 1);
      assert.deepEqual(press[0], { rawBtn: 0, col: 24, row: 12, isRelease: false });

      const wheel = tui.parseSgrSequence(rawWheel);
      assert.equal(wheel.length, 1);
      assert.equal(wheel[0].rawBtn, 64);

      const rel = tui.parseSgrSequence(rawRelease);
      assert.equal(rel[0].isRelease, true);
    });
  });

  describe("2. Row-1 Full Top Bar (Top-Left Sub-Tabs & Top-Right [ ☰ Menu ])", () => {
    it("Renders top-left sub-tabs, [ + New ], and top-right [ ☰ Menu ] on Row 1", () => {
      const frame = tui.renderFrame(100, 30);
      assert.equal(frame.length, 30);
      const topLine = stripAnsi(frame[0]);

      assert.ok(topLine.includes("[ ✦ Home ]"), "Row 1 must include [ ✦ Home ] sub-tab");
      assert.ok(topLine.includes("[ + New ]"), "Row 1 must include [ + New ] button");
      assert.ok(topLine.includes("[ ☰ Menu ]"), "Row 1 must include top-right [ ☰ Menu ] button");

      const hits = tui.getHitboxes().filter((h) => h.row === 1);
      assert.ok(hits.some((h) => h.action === "switch_subtab"), "Must register switch_subtab hitbox");
      assert.ok(hits.some((h) => h.action === "new_subtab"), "Must register new_subtab hitbox");
      const menuHit = hits.find((h) => h.action === "toggle_sidebar");
      assert.ok(menuHit, "Must register toggle_sidebar hitbox");
      assert.ok(menuHit.startCol > 70, "Menu button must be right-aligned on Row 1");
    });

    it("Clicking [ + New ], sub-tab close ×, and pressing Tab manages sub-tabs cleanly", async () => {
      tui.renderFrame(100, 30);
      const newHit = tui.getHitboxes().find((h) => h.action === "new_subtab");
      assert.ok(newHit);
      await tui.handleHit(newHit.row, newHit.startCol + 1);

      let state = tui.getState();
      assert.equal(state.subTabs.length, 2, "Must open a second sub-tab");
      assert.equal(state.activeSubTabIndex, 1);

      // Tab key cycles back to Home (index 0) and forward again
      await tui.handleKey("", { name: "tab" });
      state = tui.getState();
      assert.equal(state.activeSubTabIndex, 0, "Tab must cycle to [ ✦ Home ]");
      assert.equal(state.activeNav, 0);

      // Re-render to inspect closable sub-tab hitboxes
      tui.renderFrame(100, 30);
      const closeHit = tui.getHitboxes().find((h) => h.action === "close_subtab");
      assert.ok(closeHit, "Closable conversation sub-tab must expose × hitbox");
      await tui.handleHit(closeHit.row, closeHit.startCol);

      state = tui.getState();
      assert.equal(state.subTabs.length, 1, "Closing sub-tab removes it while keeping Home");
      assert.equal(state.subTabs[0].kind, "home");
    });
  });

  describe("3. Eliminated Fixed Left-Sidebar & Centered Composer UX", () => {
    it("Hides sidebar by default and centers composer box on Home view", () => {
      assert.equal(tui.getState().rightSidebarOpen, false, "rightSidebarOpen must default to false");
      assert.deepEqual(tui.renderSidebar(), [], "renderSidebar must return [] when collapsed");

      const frame = tui.renderFrame(100, 30);
      const plainFrame = frame.map(stripAnsi).join("\n");

      assert.ok(!plainFrame.includes("MAILBOXES"), "Fixed left-sidebar clutter must be hidden by default");
      assert.ok(plainFrame.includes("✉ Intercom"), "Centered Home view must show ✉ Intercom heading");
      assert.ok(plainFrame.includes("To: [ @jules ▾ ]"), "Centered composer must render target selector pill");
      assert.ok(plainFrame.includes("[ ↵ Send ]"), "Centered composer must render [ ↵ Send ] button");

      const hits = tui.getHitboxes();
      const targetHit = hits.find((h) => h.action === "toggle_target_dropdown");
      const sendHit = hits.find((h) => h.action === "btn_send");
      const focusHit = hits.find((h) => h.action === "focus_compose");
      assert.ok(targetHit && sendHit && focusHit, "Composer must expose clickable target, send, and input hitboxes");
      // Centered horizontally: target dropdown should start away from col 1 edge
      assert.ok(focusHit.startCol > 10, `Composer box must be horizontally centered (startCol=${focusHit.startCol})`);
    });
  });

  describe("4. Collapsible RIGHT-Side Sidebar (Menu Button & Ctrl+B)", () => {
    it("Opens on the RIGHT side via [ ☰ Menu ] click or Ctrl+B and exposes clickable nav, peers, and channels", async () => {
      tui.renderFrame(100, 30);
      const menuHit = tui.getHitboxes().find((h) => h.action === "toggle_sidebar");
      await tui.handleHit(menuHit.row, menuHit.startCol);

      assert.equal(tui.getState().rightSidebarOpen, true);
      tui.renderFrame(100, 30);

      const hits = tui.getHitboxes();
      const navHits = hits.filter((h) => h.action === "nav");
      const peerHits = hits.filter((h) => h.action === "select_agent");
      const chHits = hits.filter((h) => h.action === "select_channel");

      assert.equal(navHits.length, 7, "Right sidebar must expose all 7 navigation categories");
      assert.equal(peerHits.length, 5, "Right sidebar must expose all 5 agent peers");
      assert.equal(chHits.length, 3, "Right sidebar must expose all 3 topic channels");

      // Verify strict RIGHT-side placement (cols > 50 on a 100-col screen)
      for (const h of [...navHits, ...peerHits, ...chHits]) {
        assert.ok(h.startCol > 60, `Sidebar hitbox ${h.action} must render on RIGHT side (startCol=${h.startCol})`);
      }

      // Clicking a peer opens Inbox thread and sub-tab
      const opencodeHit = peerHits.find((h) => h.payload.name === "opencode");
      assert.ok(opencodeHit);
      await tui.handleHit(opencodeHit.row, opencodeHit.startCol + 2);
      assert.equal(tui.getState().selectedAgent, "opencode");
      assert.equal(tui.getState().activeNav, 1);

      // Ctrl+B closes right sidebar
      await tui.handleKey("", { name: "b", ctrl: true });
      assert.equal(tui.getState().rightSidebarOpen, false);
    });
  });

  describe("5. Target Selector Dropdown & Live `/` Slash-Command Dropdown", () => {
    it("Clicking To: [ @target ▾ ] opens real dropdown with Peers, Channels & Refresh", async () => {
      tui.renderFrame(100, 30);
      const toggleHit = tui.getHitboxes().find((h) => h.action === "toggle_target_dropdown");
      await tui.handleHit(toggleHit.row, toggleHit.startCol + 1);
      assert.equal(tui.getState().targetDropdownOpen, true);

      const frame = tui.renderFrame(100, 30).map(stripAnsi).join("\n");
      assert.ok(frame.includes("Select Target"), "Target dropdown overlay must render");
      assert.ok(frame.includes("↻ Refresh"), "Target dropdown must include [ ↻ Refresh ]");

      const alertsHit = tui.getHitboxes().find(
        (h) => h.action === "select_target_option" && h.payload.type === "channel" && h.payload.name === "alerts"
      );
      assert.ok(alertsHit, "Must register hitbox for #alerts inside target dropdown");
      await tui.handleHit(alertsHit.row, alertsHit.startCol + 1);

      const state = tui.getState();
      assert.equal(state.selectedType, "channel");
      assert.equal(state.selectedChannel, "alerts");
      assert.equal(state.targetDropdownOpen, false);
    });

    it("Typing `/` displays live filterable slash-command menu navigable by arrows/click/Enter", async () => {
      tui.setState({ composerBuffer: "/s" });
      const filtered = tui.getFilteredSlashCommands("/s");
      assert.ok(filtered.some((c) => c.cmd === "/settings"), "Filter `/s` must include /settings");
      assert.ok(!filtered.some((c) => c.cmd === "/peers"), "Filter `/s` must exclude /peers");

      const frame = tui.renderFrame(100, 30).map(stripAnsi).join("\n");
      assert.ok(frame.includes("/ Commands"), "Composer starting with `/` must render live slash dropdown");
      assert.ok(frame.includes("/settings"), "Filtered slash command must be visible in dropdown");

      const setHit = tui.getHitboxes().find(
        (h) => h.action === "select_slash_command" && h.payload.cmd === "/settings"
      );
      assert.ok(setHit, "Slash command row must have clickable hitbox");
      await tui.handleHit(setHit.row, setHit.startCol + 1);

      assert.equal(tui.getState().activeNav, 5, "Selecting /settings opens Settings view");
      assert.equal(tui.getState().composerBuffer, "", "Executing non-arg slash command clears prompt");
    });
  });

  describe("6. Info Refresh, Settings Toggles & Toggleable Lower-Corner Stats", () => {
    it("Info view renders mesh stats and clickable [ ↻ Refresh ] button", async () => {
      tui.setState({ activeNav: 4 }); // Info
      const frame = tui.renderFrame(100, 30).map(stripAnsi).join("\n");
      assert.ok(frame.includes("Intercom Mesh Health & System Info"));
      assert.ok(frame.includes("[ ↻ Refresh ]"));
      assert.ok(tui.getHitboxes().some((h) => h.action === "btn_refresh"));
    });

    it("Settings view toggles Lower-Corner Stats ON/OFF interactively", async () => {
      let frame = tui.renderFrame(100, 30).map(stripAnsi).join("\n");
      assert.ok(frame.includes("Peers: 5 · Unread: 2 · Ch: 3 · DLQ: 0"), "Lower-corner stats visible when enabled");

      tui.setState({ activeNav: 5 }); // Settings
      tui.renderFrame(100, 30);
      const statsToggleHit = tui.getHitboxes().find(
        (h) => h.action === "toggle_setting" && h.payload.key === "showCornerStats"
      );
      assert.ok(statsToggleHit, "Corner Stats toggle row must be clickable");
      await tui.handleHit(statsToggleHit.row, statsToggleHit.startCol + 2);

      assert.equal(tui.getState().settings.showCornerStats, false);
      frame = tui.renderFrame(100, 30).map(stripAnsi).join("\n");
      assert.ok(!frame.includes("Peers: 5 · Unread: 2"), "Lower-corner stats hidden when toggled OFF");
    });
  });

  describe("7. Aesthetics & Pure Messaging Invariants", () => {
    it("Uses deep dark charcoal background palette (color 234 / #0d1117)", () => {
      const src = fs.readFileSync(TUI_PATH, "utf8");
      assert.ok(src.includes("48;5;234m"), "Main panel must use #0d1117 / xterm-234 background");
      assert.ok(src.includes("48;5;233m"), "Sidebar / header must use deep contrast 233 background");
    });

    it("Maintains 100% pure messaging focus without delegation or execution flags", () => {
      const src = fs.readFileSync(TUI_PATH, "utf8");
      assert.ok(!src.includes("--async-execution"), "TUI must never contain --async-execution");
      assert.ok(!src.includes("execute_dispatch"), "TUI must never contain execute_dispatch");
      assert.ok(!src.includes("task_flags"), "TUI must never contain task_flags");
    });
  });
});
