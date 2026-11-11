/**
 * test/unit/tui-clickability.test.js
 *
 * Clickable Intercom TUI & SGR Extended Mouse Tracking Suite.
 *
 * Tests:
 * 1. SGR mouse event routing on vertical tabs ([ Inbox ], [ Channels ], [ Peers ], [ Health ]).
 * 2. Mouse click on peer list selecting the target agent mailbox.
 * 3. Mouse click on topic channels selecting the target channel.
 * 4. Hitbox registry, boundary checking, and SGR sequence decoding.
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
      selectedAgent: "opencode",
      selectedChannel: "general",
      agentList: ["antigravity", "opencode", "jules", "sentinel"],
      channelList: ["general", "alerts", "handoffs"],
      agentIdx: 1,
      channelIdx: 0
    });
  });

  // ── 1. SGR Mouse Event Routing on Vertical Tabs ──────────────────────
  describe("1. Vertical Tabs SGR Mouse Routing", () => {
    test("NAV_TABS defines the 4 core master-detail vertical navigation tabs", () => {
      assert.deepEqual(tui.NAV_TABS, ["Inbox", "Channels", "Peers", "Health"]);
    });

    test("renderSidebar registers clickable hitboxes for all 4 navigation tabs", () => {
      tui.renderSidebar();
      const hitboxes = tui.getHitboxes();

      const navHitboxes = hitboxes.filter((h) => h.action === "nav");
      assert.equal(navHitboxes.length, 4, "Must register 4 nav hitboxes");

      for (let i = 0; i < 4; i++) {
        const hb = navHitboxes[i];
        assert.equal(hb.payload.index, i);
        assert.equal(hb.startCol, 1);
        assert.ok(hb.row >= 1, `Nav row must be valid: ${hb.row}`);
      }
    });

    test("clicking on each vertical tab switches activeNav immediately", async () => {
      tui.renderSidebar();

      // Click tab 1: Channels
      await tui.executeHitAction({ action: "nav", payload: { index: 1 } });
      assert.equal(tui.getState().activeNav, 1, "activeNav must be 1 (Channels)");

      // Click tab 2: Peers
      await tui.executeHitAction({ action: "nav", payload: { index: 2 } });
      assert.equal(tui.getState().activeNav, 2, "activeNav must be 2 (Peers)");

      // Click tab 3: Health
      await tui.executeHitAction({ action: "nav", payload: { index: 3 } });
      assert.equal(tui.getState().activeNav, 3, "activeNav must be 3 (Health)");

      // Click tab 0: Inbox
      await tui.executeHitAction({ action: "nav", payload: { index: 0 } });
      assert.equal(tui.getState().activeNav, 0, "activeNav must be 0 (Inbox)");
    });
  });

  // ── 2. Mouse Click on Peer List Selecting Target Mailbox ────────────
  describe("2. Peer List Click Selection", () => {
    test("renderSidebar registers hitboxes for every agent peer in the mailbox list", () => {
      tui.renderSidebar();
      const hitboxes = tui.getHitboxes();

      const peerHitboxes = hitboxes.filter((h) => h.action === "select_agent");
      assert.equal(peerHitboxes.length, 4, "Must register 4 peer hitboxes");

      const names = peerHitboxes.map((h) => h.payload.name);
      assert.deepEqual(names, ["antigravity", "opencode", "jules", "sentinel"]);
    });

    test("clicking on peer mailbox selects target agent and sets activeNav to Inbox (0)", async () => {
      tui.setState({ activeNav: 2, selectedAgent: "opencode" }); // currently in Peers view

      // Click on 'jules' (index 2)
      await tui.executeHitAction({
        action: "select_agent",
        payload: { name: "jules", index: 2 }
      });

      const state = tui.getState();
      assert.equal(state.selectedAgent, "jules", "selectedAgent must be jules");
      assert.equal(state.agentIdx, 2, "agentIdx must be 2");
      assert.equal(state.activeNav, 0, "activeNav must switch to 0 (Inbox conversation stream)");
    });

    test("clicking on antigravity mailbox switches target immediately", async () => {
      await tui.executeHitAction({
        action: "select_agent",
        payload: { name: "antigravity", index: 0 }
      });

      const state = tui.getState();
      assert.equal(state.selectedAgent, "antigravity");
      assert.equal(state.agentIdx, 0);
      assert.equal(state.activeNav, 0);
    });
  });

  // ── 3. Mouse Click on Topic Channels Selecting Target Channel ────────
  describe("3. Topic Channels Click Selection", () => {
    test("renderSidebar registers hitboxes for every topic channel", () => {
      tui.renderSidebar();
      const hitboxes = tui.getHitboxes();

      const chHitboxes = hitboxes.filter((h) => h.action === "select_channel");
      assert.equal(chHitboxes.length, 3, "Must register 3 channel hitboxes");

      const names = chHitboxes.map((h) => h.payload.name);
      assert.deepEqual(names, ["general", "alerts", "handoffs"]);
    });

    test("clicking on topic channel selects channel and switches activeNav to Channels (1)", async () => {
      tui.setState({ activeNav: 0, selectedChannel: "general" }); // currently in Inbox view

      // Click on '#alerts' (index 1)
      await tui.executeHitAction({
        action: "select_channel",
        payload: { name: "alerts", index: 1 }
      });

      const state = tui.getState();
      assert.equal(state.selectedChannel, "alerts", "selectedChannel must be alerts");
      assert.equal(state.channelIdx, 1, "channelIdx must be 1");
      assert.equal(state.activeNav, 1, "activeNav must switch to 1 (Channels broadcast stream)");
    });

    test("clicking on '#handoffs' channel switches target immediately", async () => {
      await tui.executeHitAction({
        action: "select_channel",
        payload: { name: "handoffs", index: 2 }
      });

      const state = tui.getState();
      assert.equal(state.selectedChannel, "handoffs");
      assert.equal(state.channelIdx, 2);
      assert.equal(state.activeNav, 1);
    });
  });

  // ── 4. SGR Mouse Protocol Decoding & Hit Testing ────────────────────
  describe("4. SGR Mouse Protocol Decoding & Hit Testing", () => {
    test("parseSgrSequence decodes standard SGR extended 1006 mouse coordinates", () => {
      const sgrPress = "\x1b[<0;15;5M";   // Button 0 (left-click press) at col 15, row 5
      const sgrRelease = "\x1b[<0;15;5m"; // Button 0 release at col 15, row 5
      const sgrWheelUp = "\x1b[<64;20;10M"; // Wheel up at col 20, row 10

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

    test("hitTest matches coordinates within registered boundary rectangle", () => {
      tui.registerHitbox(5, 1, 24, "test_action", { id: "test_1" });

      // Inside boundary
      assert.ok(tui.hitTest(5, 1));
      assert.ok(tui.hitTest(5, 12));
      assert.ok(tui.hitTest(5, 24));
      assert.equal(tui.hitTest(5, 12).payload.id, "test_1");

      // Outside boundary
      assert.equal(tui.hitTest(4, 12), null, "Wrong row must return null");
      assert.equal(tui.hitTest(6, 12), null, "Wrong row must return null");
      assert.equal(tui.hitTest(5, 0), null, "Column before startCol must return null");
      assert.equal(tui.hitTest(5, 25), null, "Column after endCol must return null");
    });
  });
});
