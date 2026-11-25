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
      scrollOffset: 0,
      selectedMessageIndex: -1,
      peerFilterActive: false,
      peerFilterQuery: "",
      composerFocusZone: "input",
      zenMode: false,
      agentMeta: {},
      activityLog: [],
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

  describe("8. Hitbox Precision, Narrow Panes & Dropdown Z-Order Fixes", () => {
    it("Info view [ View Activity ] trailing bracket is clickable and opens Activity view", async () => {
      tui.setState({
        activeNav: 4,
        activityLog: ["[10:00:00] Sent -> @jules: ping"]
      });
      const frame = tui.renderFrame(100, 30).map(stripAnsi);
      const actHit = tui.getHitboxes().find((h) => h.action === "open_activity");
      assert.ok(actHit, "open_activity hitbox must be registered");

      const rowStr = frame[actHit.row - 1];
      assert.equal(rowStr.slice(actHit.startCol - 1, actHit.endCol), "[ View Activity ]");

      // Specifically test the trailing `]` column
      const matched = tui.hitTest(actHit.row, actHit.endCol);
      assert.ok(matched && matched.action === "open_activity", "Trailing ] of [ View Activity ] must hit open_activity");
      await tui.handleHit(actHit.row, actHit.endCol);
      assert.equal(tui.getState().activeNav, 7);
    });

    it("Narrow panes (cols < 60, mainWidth < 55) render responsive labels without overflowing sidebar or shifting hitboxes", () => {
      tui.setState({
        activeNav: 1,
        rightSidebarOpen: true,
        selectedAgent: "very_long_peer_agent_name",
        threadMessages: {
          "peer:very_long_peer_agent_name": [
            { from: "very_long_peer_agent_name", message: "Checking narrow pane layout alignment", timestamp: "2026-11-25T10:00:00Z", read: false }
          ]
        }
      });

      const frame = tui.renderFrame(50, 24);
      const sidebarW = Math.min(28, Math.max(18, Math.floor(50 * 0.26)));
      const mainWidth = 50 - sidebarW;
      assert.ok(mainWidth < 55, `Expected mainWidth < 55, got ${mainWidth}`);

      for (const line of frame) {
        assert.equal(tui.stringWidth(line), 50, "Every frame row must fit exact 50 cols without overflowing sidebar");
      }

      const mainHits = tui.getHitboxes().filter((h) =>
        ["btn_refresh", "btn_mark_read", "btn_send", "btn_clear", "toggle_target_dropdown"].includes(h.action)
      );
      assert.ok(mainHits.length >= 4, "All thread/composer buttons must register hitboxes on narrow panes");
      for (const h of mainHits) {
        assert.ok(h.startCol >= 1 && h.endCol <= mainWidth, `Hitbox ${h.action} (${h.startCol}..${h.endCol}) must not cross sidebar col ${mainWidth}`);
        const plainRow = stripAnsi(frame[h.row - 1]);
        const slice = plainRow.slice(h.startCol - 1, h.endCol);
        assert.ok(slice.includes("[") && slice.includes("]"), `Hitbox ${h.action} must align with rendered brackets, got "${slice}"`);
      }
    });

    it("Active-thread Target Dropdown never overlaps Row 0 [ ↻ Refresh ] and preserves z-order", () => {
      tui.setState({
        activeNav: 1,
        selectedAgent: "jules",
        targetDropdownOpen: true,
        agentList: ["antigravity", "opencode", "jules", "sentinel", "coordinator", "hermes", "claude", "codex"],
        threadMessages: {
          "peer:jules": [
            { from: "jules", message: "Message 1", timestamp: "2026-11-25T10:00:00Z", read: false },
            { from: "jules", message: "Message 2", timestamp: "2026-11-25T10:01:00Z", read: false }
          ]
        }
      });

      const frame = tui.renderFrame(90, 18).map(stripAnsi);
      assert.ok(frame[1].includes("[ ↻ Refresh ]"), "Row 2 (thread header) must keep [ ↻ Refresh ] visible");

      const refHit = tui.getHitboxes().find((h) => h.action === "btn_refresh" && h.row === 2);
      assert.ok(refHit, "Row 2 must expose btn_refresh hitbox");
      const topMatch = tui.hitTest(refHit.row, refHit.startCol + 1);
      assert.equal(topMatch.action, "btn_refresh", "Target dropdown must not steal clicks on Row 2 [ ↻ Refresh ]");

      const dropHit = tui.getHitboxes().find((h) => h.action === "select_target_option");
      assert.ok(dropHit, "Target dropdown options must register hitboxes");
      assert.ok(dropHit.row > 2, "Dropdown options must stay below thread header Row 2");
      assert.equal(tui.hitTest(dropHit.row, dropHit.startCol + 1).action, "select_target_option");
    });

    it("Help view passes screenStartRow, exposes [ × Close ] + clickable slash rows, includes /activity & /zen, and fixes Home hint", async () => {
      assert.ok(tui.SLASH_COMMANDS.some((c) => c.cmd === "/activity"));
      assert.ok(tui.SLASH_COMMANDS.some((c) => c.cmd === "/zen"));

      const homeFrame = tui.renderFrame(100, 30).map(stripAnsi).join("\n");
      assert.ok(homeFrame.includes("Esc then z"), "Home hint must read 'Esc then z'");
      assert.ok(!homeFrame.includes("[Esc+z]"), "Home hint must not contain [Esc+z] typo");

      tui.setState({ activeNav: 6 });
      const helpFrame = tui.renderFrame(100, 30).map(stripAnsi);
      const helpText = helpFrame.join("\n");
      assert.ok(helpText.includes("[ × Close ]"), "Help view must render [ × Close ] button");
      assert.ok(helpText.includes("/activity"), "Help view must list /activity");
      assert.ok(helpText.includes("/zen"), "Help view must list /zen");

      const closeHit = tui.getHitboxes().find((h) => h.action === "close_help");
      assert.ok(closeHit, "Help view must register close_help hitbox");
      assert.equal(helpFrame[closeHit.row - 1].slice(closeHit.startCol - 1, closeHit.endCol), "[ × Close ]");

      const actSlashHit = tui.getHitboxes().find(
        (h) => h.action === "select_slash_command" && h.payload.cmd === "/activity"
      );
      assert.ok(actSlashHit, "Help view must register clickable slash-command row for /activity");
      await tui.handleHit(actSlashHit.row, actSlashHit.startCol + 2);
      assert.equal(tui.getState().activeNav, 7, "Clicking /activity row in Help opens Activity view");

      tui.setState({ activeNav: 6 });
      tui.renderFrame(100, 30);
      const closeHit2 = tui.getHitboxes().find((h) => h.action === "close_help");
      await tui.handleHit(closeHit2.row, closeHit2.endCol);
      assert.notEqual(tui.getState().activeNav, 6, "Clicking [ × Close ] exits Help view");
    });

    it("Row-1 sub-tabs render ◀ / ▶ overflow indicators and sidebar nav syncs activeSubTabIndex", async () => {
      const manyTabs = [
        { id: "home", kind: "home", target: null, label: "✦ Home", closable: false },
        { id: "peer:antigravity", kind: "peer", target: "antigravity", label: "@antigravity", closable: true },
        { id: "peer:opencode", kind: "peer", target: "opencode", label: "@opencode", closable: true },
        { id: "peer:jules", kind: "peer", target: "jules", label: "@jules", closable: true },
        { id: "peer:sentinel", kind: "peer", target: "sentinel", label: "@sentinel", closable: true },
        { id: "peer:coordinator", kind: "peer", target: "coordinator", label: "@coordinator", closable: true },
        { id: "channel:general", kind: "channel", target: "general", label: "#general", closable: true }
      ];
      tui.setState({ subTabs: manyTabs, activeSubTabIndex: 0, subTabScrollOffset: 0 });
      let top = stripAnsi(tui.renderFrame(75, 24)[0]);
      assert.ok(top.includes("▶"), "Overflowing sub-tabs must render ▶ indicator");

      const nextInd = tui.getHitboxes().find((h) => h.action === "scroll_subtabs" && h.payload.delta === 1);
      assert.ok(nextInd, "Must register scroll_subtabs forward hitbox");
      await tui.handleHit(nextInd.row, nextInd.startCol + 1);

      top = stripAnsi(tui.renderFrame(75, 24)[0]);
      assert.ok(top.includes("◀"), "Scrolled sub-tabs must render ◀ indicator");

      // Navigating via sidebar nav to Inbox or Channels must sync activeSubTabIndex away from Home
      tui.setState({ rightSidebarOpen: true, activeNav: 0, activeSubTabIndex: 0, selectedAgent: "jules" });
      tui.renderFrame(100, 30);
      const inboxNav = tui.getHitboxes().find((h) => h.action === "nav" && h.payload.index === 1);
      await tui.handleHit(inboxNav.row, inboxNav.startCol + 2);
      assert.equal(tui.getState().activeNav, 1);
      assert.notEqual(tui.getState().activeSubTabIndex, 0, "Sidebar nav to Inbox must sync activeSubTabIndex");
    });
  });

  describe("9. Visual Contrast & Light Theme Readability", () => {
    it("fitToWidth restores surface background after inner ANSI resets", () => {
      const bg = "\x1b[48;5;234m";
      const out = tui.fitToWidth("\x1b[97mHello\x1b[0m", 12, bg);
      assert.ok(out.includes(`\x1b[0m${bg}`), "fitToWidth must restore bg after inner reset");
      assert.equal(tui.stringWidth(out), 12);
    });

    it("LIGHT_THEME uses fgOnActive on ON pill and fgMuted on [READ] and dropdown headers", () => {
      tui.setState({
        activeNav: 5,
        settings: { darkTheme: false, readReceipts: true, showTimestamps: true, showCornerStats: true }
      });
      const settingsFrame = tui.renderFrame(100, 30).join("\n");
      assert.ok(settingsFrame.includes("\x1b[48;5;32m\x1b[1m\x1b[97m ON  "), "Light theme ON pill must use fgOnActive (97m) on bgActiveNav");
      assert.ok(!settingsFrame.includes("\x1b[48;5;32m\x1b[1m\x1b[38;5;28m ON"), "Light theme ON pill must not use dark green on blue");

      tui.setState({
        activeNav: 1,
        selectedAgent: "jules",
        targetDropdownOpen: true,
        threadMessages: {
          "peer:jules": [{ from: "jules", message: "Ack", timestamp: "2026-11-25T10:00:00Z", read: true }]
        }
      });
      const threadFrame = tui.renderFrame(100, 30).join("\n");
      assert.ok(threadFrame.includes("\x1b[38;5;240m[READ]"), "Light theme [READ] receipt must use theme.fgMuted");
      assert.ok(threadFrame.includes("\x1b[38;5;240m\x1b[1mPEERS"), "Light theme dropdown PEERS header must use theme.fgMuted");
      assert.ok(threadFrame.includes("\x1b[38;5;240m\x1b[1mCHANNELS"), "Light theme dropdown CHANNELS header must use theme.fgMuted");
    });
  });

  describe("10. Functional Controls: Unread Badges, Mark Read, Scroll/Filter, Channels, Reply/Forward & Focus Ring", () => {
    it("Shows unread count badge on @peer sub-tab and marks inbox read via [ ✓ Mark Read ] and /read", async () => {
      tui.setState({
        activeNav: 1,
        selectedAgent: "jules",
        subTabs: [
          { id: "home", kind: "home", target: null, label: "✦ Home", closable: false },
          { id: "peer:jules", kind: "peer", target: "jules", label: "@jules", closable: true }
        ],
        activeSubTabIndex: 1,
        agentMeta: { jules: { total: 2, unread: 2, online: true } },
        threadMessages: {
          "peer:jules": [
            { from: "jules", message: "First unread", timestamp: "2026-11-25T10:00:00Z", read: false },
            { from: "jules", message: "Second unread", timestamp: "2026-11-25T10:01:00Z", read: false }
          ]
        }
      });

      let frame = tui.renderFrame(100, 30).map(stripAnsi);
      assert.ok(frame[0].includes("@jules (2)"), "Row-1 @peer sub-tab must show unread count badge");
      assert.ok(frame[1].includes("[ ✓ Mark Read ]"), "Peer thread header must show [ ✓ Mark Read ] button");

      const markHit = tui.getHitboxes().find((h) => h.action === "btn_mark_read");
      assert.ok(markHit);
      await tui.handleHit(markHit.row, markHit.startCol + 1);

      frame = tui.renderFrame(100, 30).map(stripAnsi);
      assert.ok(!frame[0].includes("@jules (2)"), "Unread badge clears after Mark Read");
      assert.ok(frame.join("\n").includes("[READ]"), "Messages display [READ] after Mark Read");

      // Also verify /read slash command
      tui.setState({
        agentMeta: { jules: { total: 1, unread: 1, online: true } },
        threadMessages: { "peer:jules": [{ from: "jules", message: "New ping", read: false }] }
      });
      await tui.executeSlashCommand("/read");
      assert.equal(tui.getState().meshStats.unread, 0);
    });

    it("Peers and Activity lists scroll with overflow hints, and Peers view filters by /", async () => {
      const manyPeers = Array.from({ length: 25 }, (_, i) => `peer_${String(i).padStart(2, "0")}`);
      manyPeers.push("jules_special");
      tui.setState({ activeNav: 3, agentList: manyPeers, selectedAgent: "peer_00", scrollOffset: 0 });

      let frame = tui.renderFrame(90, 18).map(stripAnsi).join("\n");
      assert.ok(frame.includes("↓"), "Peers list must render ↓ overflow hint");

      await tui.handleMouseWheel(65);
      assert.ok(tui.getState().scrollOffset > 0, "Mouse wheel down scrolls Peers list");
      frame = tui.renderFrame(90, 18).map(stripAnsi).join("\n");
      assert.ok(frame.includes("↑"), "Scrolled Peers list must render ↑ overflow hint");

      // Activate Peer Filter with / and type "jules"
      await tui.handleKey("/", { name: "/" });
      assert.equal(tui.getState().peerFilterActive, true);
      for (const ch of "jules") {
        await tui.handleKey(ch, { name: ch });
      }
      assert.equal(tui.getState().peerFilterQuery, "jules");
      frame = tui.renderFrame(90, 18).map(stripAnsi).join("\n");
      assert.ok(frame.includes("@jules_special"), "Filtered Peers view shows matching peer");
      assert.ok(!frame.includes("@peer_00"), "Filtered Peers view hides non-matching peers");

      // Activity view scrolling
      const logs = Array.from({ length: 25 }, (_, i) => `[10:00:${String(i).padStart(2, "0")}] Event ${i}`);
      tui.setState({ activeNav: 7, activityLog: logs, scrollOffset: 0 });
      let actFrame = tui.renderFrame(90, 18).map(stripAnsi).join("\n");
      assert.ok(actFrame.includes("↓"), "Activity list must render ↓ overflow hint");
      await tui.handleMouseWheel(65);
      assert.ok(tui.getState().scrollOffset > 0);
      actFrame = tui.renderFrame(90, 18).map(stripAnsi).join("\n");
      assert.ok(actFrame.includes("↑"), "Scrolled Activity list must render ↑ overflow hint");
    });

    it("Channels bar exposes [ + Channel ] and /channel <name> quick-opens channel", async () => {
      tui.setState({ activeNav: 2, selectedType: "channel", selectedChannel: "general" });
      const frame = tui.renderFrame(100, 30).map(stripAnsi).join("\n");
      assert.ok(frame.includes("[ #general ]"), "Channels bar renders channel pills");
      assert.ok(frame.includes("[ + Channel ]"), "Channels bar renders [ + Channel ] button");

      const addChHit = tui.getHitboxes().find((h) => h.action === "new_channel_prompt");
      assert.ok(addChHit);
      await tui.handleHit(addChHit.row, addChHit.startCol + 1);
      assert.equal(tui.getState().composerBuffer, "/channel ");

      const res = await tui.executeSlashCommand("/channel devops");
      assert.equal(res.action, "slash_channel_open");
      const st = tui.getState();
      assert.equal(st.selectedChannel, "devops");
      assert.ok(st.channelList.includes("devops"));
      assert.ok(st.subTabs.some((t) => t.id === "channel:devops"));
    });

    it("Thread view supports Message Selection, [ ↩ Reply ] / [ ↪ Forward ], and Tab focus ring", async () => {
      tui.setState({
        activeNav: 1,
        selectedAgent: "jules",
        subTabs: [
          { id: "home", kind: "home", target: null, label: "✦ Home", closable: false },
          { id: "peer:jules", kind: "peer", target: "jules", label: "@jules", closable: true }
        ],
        activeSubTabIndex: 1,
        threadMessages: {
          "peer:jules": [
            { from: "jules", message: "Deploy check complete", timestamp: "2026-11-25T10:00:00Z", read: false }
          ]
        }
      });

      tui.renderFrame(100, 30);
      const msgHit = tui.getHitboxes().find((h) => h.action === "select_message");
      assert.ok(msgHit, "Message bubble must expose select_message hitbox");
      await tui.handleHit(msgHit.row, msgHit.startCol + 2);
      assert.equal(tui.getState().selectedMessageIndex, 0);

      const frame = tui.renderFrame(100, 30).map(stripAnsi).join("\n");
      assert.ok(frame.includes("[ ↩ Reply ]"), "Selected message must show [ ↩ Reply ]");
      assert.ok(frame.includes("[ ↪ Forward ]"), "Selected message must show [ ↪ Forward ]");

      const replyHit = tui.getHitboxes().find((h) => h.action === "reply_message");
      assert.ok(replyHit);
      await tui.handleHit(replyHit.row, replyHit.startCol + 1);
      assert.equal(tui.getState().composerBuffer, "@jules ");

      tui.renderFrame(100, 30);
      const fwdHit = tui.getHitboxes().find((h) => h.action === "forward_message");
      assert.ok(fwdHit);
      await tui.handleHit(fwdHit.row, fwdHit.startCol + 1);
      assert.equal(tui.getState().composerBuffer, "/msg  [Fwd from @jules]: Deploy check complete");
      assert.equal(tui.getState().composerCursor, 5);

      // Tab focus ring between Composer Input -> To: -> Send -> Clear -> Input
      tui.setState({ composerBuffer: "hello world", composerFocusZone: "input", composerFocused: true });
      await tui.handleKey("", { name: "tab" });
      assert.equal(tui.getState().composerFocusZone, "target");
      await tui.handleKey("", { name: "tab" });
      assert.equal(tui.getState().composerFocusZone, "send");
      await tui.handleKey("", { name: "tab" });
      assert.equal(tui.getState().composerFocusZone, "clear");
      await tui.handleKey("", { name: "tab" });
      assert.equal(tui.getState().composerFocusZone, "input");

      // Shift+Tab steps backward and Enter on target opens dropdown
      await tui.handleKey("", { name: "tab", shift: true });
      assert.equal(tui.getState().composerFocusZone, "clear");
      await tui.handleKey("", { name: "left" }); // send
      await tui.handleKey("", { name: "left" }); // target
      assert.equal(tui.getState().composerFocusZone, "target");
      await tui.handleKey("", { name: "return" });
      assert.equal(tui.getState().targetDropdownOpen, true);
    });
  });
});
