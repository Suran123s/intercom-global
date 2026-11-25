/**
 * test/unit/tui-clickability.test.js
 *
 * Wave 6 Clickable Intercom TUI API, Right Sidebar, Dropdowns & SGR Mouse Unit Suite.
 *
 * Tests:
 * 1. Minimalist 7-category navigation (`Home`, `Inbox`, `Channels`, `Peers`, `Info`, `Settings`, `Help`)
 *    with collapsible RIGHT-side sidebar hidden by default.
 * 2. Peer & topic channel selection opening sub-tabs and routing to Inbox/Channels.
 * 3. Top-left clickable sub-tabs, [ + New ], [ × ], [ ☰ Menu ], and `Tab` switching.
 * 4. Centered composer, Target Selector dropdown, and `/` live slash-command menu.
 * 5. SGR 1006 Mouse Protocol decoding, Readline shortcuts, and Hitbox boundary precision.
 */

const { describe, test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const tui = require("../../bin/intercom-tui.js");

describe("Intercom TUI Clickability & SGR Mouse Event Suite", () => {
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
      agentList: ["antigravity", "opencode", "jules", "sentinel"],
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
      selectedSettingIndex: 0
    });
  });

  // ── 1. Wave 6 Minimalist Nav & Collapsible Right Sidebar ─────────────
  describe("1. Collapsible Right Sidebar & Vertical Categories", () => {
    test("NAV_TABS defines the 7 clean categories anchored at Home", () => {
      assert.deepEqual(tui.NAV_TABS, [
        "Home",
        "Inbox",
        "Channels",
        "Peers",
        "Info",
        "Settings",
        "Help"
      ]);
    });

    test("renderSidebar is hidden by default and renders RIGHT-side hitboxes when open", () => {
      assert.deepEqual(tui.renderSidebar(), [], "Sidebar must be collapsed by default");
      assert.equal(tui.getHitboxes().length, 0, "Collapsed sidebar registers zero clutter hitboxes");

      tui.setState({ rightSidebarOpen: true });
      tui.renderSidebar();
      const hitboxes = tui.getHitboxes();

      const navHits = hitboxes.filter((h) => h.action === "nav");
      assert.equal(navHits.length, 7, "Must register all 7 category hitboxes when right sidebar is open");
      assert.deepEqual(navHits.map((h) => h.payload.label), tui.NAV_TABS);

      const minStartCol = Math.min(...navHits.map((h) => h.startCol));
      assert.ok(minStartCol > 50, `Right sidebar must align on right half (minStartCol=${minStartCol})`);
    });

    test("clicking each category in open right sidebar switches activeNav immediately", async () => {
      tui.setState({ rightSidebarOpen: true });
      tui.renderSidebar();
      const navHits = tui.getHitboxes().filter((h) => h.action === "nav");

      for (let i = 0; i < navHits.length; i++) {
        const hit = navHits[i];
        const matched = tui.hitTest(hit.row, hit.startCol + 2);
        assert.ok(matched, `Should hit nav tab index ${i} at row ${hit.row}, col ${hit.startCol + 2}`);
        assert.equal(matched.action, "nav");

        await tui.executeHitAction(matched);
        assert.equal(tui.getState().activeNav, hit.payload.index);
      }
    });
  });

  // ── 2. Peer List Click Selection (via Open Right Sidebar) ─────────────
  describe("2. Peer List Click Selection", () => {
    test("renderSidebar registers hitboxes for every agent peer when open", () => {
      tui.setState({ rightSidebarOpen: true });
      tui.renderSidebar();
      const peerHits = tui.getHitboxes().filter((h) => h.action === "select_agent");

      assert.equal(peerHits.length, 4, "Must register 4 peer hitboxes");
      assert.deepEqual(peerHits.map((h) => h.payload.name), ["antigravity", "opencode", "jules", "sentinel"]);
    });

    test("clicking on peer mailbox selects target agent, opens sub-tab, and sets activeNav to Inbox (1)", async () => {
      tui.setState({ rightSidebarOpen: true });
      tui.renderSidebar();
      const sentinelHit = tui.getHitboxes().find(
        (h) => h.action === "select_agent" && h.payload.name === "sentinel"
      );
      assert.ok(sentinelHit);

      const midCol = Math.floor((sentinelHit.startCol + sentinelHit.endCol) / 2);
      const matched = tui.hitTest(sentinelHit.row, midCol);
      await tui.executeHitAction(matched);

      const state = tui.getState();
      assert.equal(state.selectedAgent, "sentinel");
      assert.equal(state.selectedType, "peer");
      assert.equal(state.agentIdx, 3);
      assert.equal(state.activeNav, 1, "activeNav must switch to 1 (Inbox conversation stream)");
      assert.ok(state.subTabs.some((t) => t.id === "peer:sentinel"), "Must open @sentinel sub-tab");
    });

    test("clicking on opencode mailbox switches target immediately via SGR hitTest", async () => {
      tui.setState({ rightSidebarOpen: true });
      tui.renderSidebar();
      const opencodeHit = tui.getHitboxes().find(
        (h) => h.action === "select_agent" && h.payload.name === "opencode"
      );
      assert.ok(opencodeHit);

      await tui.handleHit(opencodeHit.row, opencodeHit.startCol + 3);
      const state = tui.getState();
      assert.equal(state.selectedAgent, "opencode");
      assert.equal(state.agentIdx, 1);
      assert.equal(state.activeNav, 1);
    });
  });

  // ── 3. Topic Channels Click Selection ─────────────────────────────────
  describe("3. Topic Channels Click Selection", () => {
    test("renderSidebar registers hitboxes for every topic channel when open", () => {
      tui.setState({ rightSidebarOpen: true });
      tui.renderSidebar();
      const channelHits = tui.getHitboxes().filter((h) => h.action === "select_channel");

      assert.equal(channelHits.length, 3, "Must register 3 channel hitboxes");
      assert.deepEqual(channelHits.map((h) => h.payload.name), ["general", "alerts", "handoffs"]);
    });

    test("clicking on topic channel selects channel, opens sub-tab, and sets activeNav to Channels (2)", async () => {
      tui.setState({ rightSidebarOpen: true });
      tui.renderSidebar();
      const alertsHit = tui.getHitboxes().find(
        (h) => h.action === "select_channel" && h.payload.name === "alerts"
      );
      assert.ok(alertsHit);

      await tui.executeHitAction(tui.hitTest(alertsHit.row, alertsHit.startCol + 2));

      const state = tui.getState();
      assert.equal(state.selectedChannel, "alerts");
      assert.equal(state.selectedType, "channel");
      assert.equal(state.channelIdx, 1);
      assert.equal(state.activeNav, 2, "activeNav must switch to 2 (Channels broadcast stream)");
      assert.ok(state.subTabs.some((t) => t.id === "channel:alerts"), "Must open #alerts sub-tab");
    });

    test("clicking on '#handoffs' channel switches target immediately", async () => {
      tui.setState({ rightSidebarOpen: true });
      tui.renderSidebar();
      const handoffHit = tui.getHitboxes().find(
        (h) => h.action === "select_channel" && h.payload.name === "handoffs"
      );
      assert.ok(handoffHit);

      await tui.handleHit(handoffHit.row, handoffHit.startCol + 2);
      const state = tui.getState();
      assert.equal(state.selectedChannel, "handoffs");
      assert.equal(state.channelIdx, 2);
      assert.equal(state.activeNav, 2);
    });
  });

  // ── 4. Slash Commands, Dropdowns & Readline Editing ──────────────────
  describe("4. Slash Menu, Target Dropdown & Readline Composer Editing", () => {
    test("SLASH_COMMANDS exposes all 13 intercom commands and keyboard navigation selects them", async () => {
      assert.equal(tui.SLASH_COMMANDS.length, 13);
      const expected = ["/msg", "/channel", "/peers", "/info", "/settings", "/refresh", "/clear", "/menu", "/new", "/activity", "/zen", "/read", "/help"];
      assert.deepEqual(tui.SLASH_COMMANDS.map((c) => c.cmd), expected);

      await tui.handleKey("/", { name: "/" });
      assert.equal(tui.getState().slashMenuOpen, true);

      // Esc dismisses slash menu cleanly while keeping buffer intact until cleared
      await tui.handleKey("", { name: "escape" });
      assert.equal(tui.getState().slashMenuOpen, false);

      // Type 'peers' and run /peers via Enter
      tui.setState({ composerBuffer: "/pee" });
      assert.equal(tui.getState().slashMenuOpen, true);
      const res = await tui.handleKey("", { name: "return" });
      assert.equal(res.action, "slash_executed");
      assert.equal(tui.getState().activeNav, 3, "Must navigate to Peers view");
    });

    test("Target dropdown supports Up/Down/Enter keyboard selection", async () => {
      tui.renderFrame(100, 30);
      const toggleHit = tui.getHitboxes().find((h) => h.action === "toggle_target_dropdown");
      await tui.handleHit(toggleHit.row, toggleHit.startCol);
      assert.equal(tui.getState().targetDropdownOpen, true);

      await tui.handleKey("", { name: "down" }); // index 1 -> opencode
      await tui.handleKey("", { name: "return" });

      const state = tui.getState();
      assert.equal(state.targetDropdownOpen, false);
      assert.equal(state.selectedAgent, "opencode");
    });

    test("Readline Ctrl+A / Ctrl+K / Ctrl+W work accurately on centered composer buffer", async () => {
      await tui.handleKey("h", { name: "h" });
      await tui.handleKey("i", { name: "i" });
      await tui.handleKey(" ", { name: "space" });
      await tui.handleKey("w", { name: "w" });
      assert.equal(tui.getState().composerBuffer, "hi w");

      await tui.handleKey("", { name: "w", ctrl: true });
      assert.equal(tui.getState().composerBuffer, "hi ");

      await tui.handleKey("", { name: "a", ctrl: true });
      assert.equal(tui.getState().composerCursor, 0);

      await tui.handleKey("", { name: "k", ctrl: true });
      assert.equal(tui.getState().composerBuffer, "");
    });
  });

  // ── 5. SGR Mouse Protocol Decoding & Hit Testing (Overlay Priority) ─
  describe("5. SGR Mouse Protocol Decoding & Hit Testing", () => {
    test("parseSgrSequence decodes standard SGR extended 1006 mouse coordinates", () => {
      const sgrPress = "\x1b[<0;15;5M";
      const sgrRelease = "\x1b[<0;15;5m";
      const sgrWheelUp = "\x1b[<64;20;10M";

      const parsedPress = tui.parseSgrSequence(sgrPress);
      assert.equal(parsedPress.length, 1);
      assert.equal(parsedPress[0].rawBtn, 0);
      assert.equal(parsedPress[0].col, 15);
      assert.equal(parsedPress[0].row, 5);
      assert.equal(parsedPress[0].isRelease, false);

      const parsedRelease = tui.parseSgrSequence(sgrRelease);
      assert.equal(parsedRelease[0].isRelease, true);

      const parsedWheel = tui.parseSgrSequence(sgrWheelUp);
      assert.equal(parsedWheel[0].rawBtn, 64);
    });

    test("hitTest matches boundary rectangle and gives topmost overlay priority", () => {
      tui.registerHitbox(5, 1, 24, "base_action", { id: "base" });
      tui.registerHitbox(5, 10, 20, "overlay_action", { id: "overlay" });

      assert.equal(tui.hitTest(5, 1).payload.id, "base");
      assert.equal(tui.hitTest(5, 12).payload.id, "overlay", "Topmost overlay must win on overlap");
      assert.equal(tui.hitTest(5, 24).payload.id, "base");

      assert.equal(tui.hitTest(4, 12), null, "Wrong row must return null");
      assert.equal(tui.hitTest(5, 0), null, "Column before startCol must return null");
      assert.equal(tui.hitTest(5, 25), null, "Column after endCol must return null");
    });
  });
});
