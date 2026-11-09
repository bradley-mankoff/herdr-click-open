/**
 * The click-open herdr plugin (`fac-qpv.7.2`): Ctrl-clicking a Bead link on the board shows
 * that Bead in the nearest board tab, with the board switched to the link's project first.
 *
 * The seam is the plugin's board action, run the way herdr runs it: `bash board.sh` in a
 * herdr pane, with the clicked link in `HERDR_PLUGIN_CLICKED_URL`. herdr, terminal-browser,
 * the Mac's default browser (through `osascript`) and the board's websocket server are
 * stand-ins at those edges, each writing down how it was called; the tests read those logs
 * instead of looking inside the script.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = root;

/** The link bead-links.ts writes in a Project Manager's reply. */
const boardLink = (port: number, issue: string, repo: string): string =>
	`http://127.0.0.1:${port}/#/board?issue=${encodeURIComponent(issue)}&workspace=${encodeURIComponent(repo)}`;

/** One unmasked websocket text frame, the way a server sends it. */
function frame(payload: Buffer): Buffer {
	if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(payload.length);
	return Buffer.concat([Buffer.from([0x81, 126]), length, payload]);
}

/**
 * The board's websocket server, stood in for at the edge: it answers `set-workspace` the
 * way beads-ui does and keeps every message it was sent.
 */
async function boardStub() {
	const messages: Array<{ id: string; type: string; payload: { path?: string } }> = [];
	const sockets = new Set<Socket>();
	const server = createServer((_request, response) => {
		response.writeHead(404);
		response.end();
	});
	server.on("upgrade", (request, socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		const key = String(request.headers["sec-websocket-key"] ?? "");
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 2) {
				const opcode = buffered[0] & 0x0f;
				const masked = (buffered[1] & 0x80) !== 0;
				let length = buffered[1] & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffered.length < 4) return;
					length = buffered.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (buffered.length < 10) return;
					length = Number(buffered.readBigUInt64BE(2));
					offset = 10;
				}
				const maskAt = offset;
				if (masked) offset += 4;
				if (buffered.length < offset + length) return;
				const payload = Buffer.from(buffered.subarray(offset, offset + length));
				if (masked) for (let i = 0; i < length; i += 1) payload[i] ^= buffered[maskAt + (i % 4)];
				buffered = buffered.subarray(offset + length);
				if (opcode === 0x1) {
					const message = JSON.parse(payload.toString("utf8"));
					messages.push(message);
					socket.write(
						frame(
							Buffer.from(
								JSON.stringify({
									id: message.id,
									ok: true,
									type: message.type,
									payload: { changed: true, workspace: { root_dir: message.payload?.path } },
								}),
							),
						),
					);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		port,
		base: `http://127.0.0.1:${port}/`,
		messages,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

type Board = Awaited<ReturnType<typeof boardStub>>;

type Logs = { herdr: string; terminalBrowser: string; osascript: string; open: string };

type Machine = {
	home: string;
	logs: Logs;
	click: (url: string) => Promise<{ status: number | null; stdout: string; stderr: string }>;
	/** The default browser this Mac's LaunchServices setting names, by bundle id. */
	setDefaultBrowser: (bundleId: string) => void;
	/** What `herdr pane list` prints: the panes of the clicked pane's workspace. */
	herdrPanes: (panes: string[]) => void;
	/** What `terminal-browser ls --all --json` prints. */
	terminalBrowsers: (browsers: unknown[]) => void;
	/** What the default browser's AppleScript lists: one `window<TAB>tab<TAB>url` a line. */
	browserTabs: (lines: string[]) => void;
};

/** A stand-in at one edge: it writes down each call's arguments, then answers. */
const stub = (path: string, log: string, body: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`#!/bin/sh\nprintf '%s\\n' --- >> '${log}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n${body}\n`,
	);
	chmodSync(path, 0o755);
};

/** One temporary Mac: a HOME whose settings say which browser, and stand-ins on PATH. */
const makeMachine = (): Machine => {
	const dir = mkdtempSync(join(tmpdir(), "factory-click-open-"));
	const home = join(dir, "home");
	// The plugin prepends $HOME/.local/bin, where herdr loads the tools it runs, to PATH.
	const bin = join(home, ".local", "bin");
	const logs: Logs = {
		herdr: join(dir, "herdr.log"),
		terminalBrowser: join(dir, "terminal-browser.log"),
		osascript: join(dir, "osascript.log"),
		open: join(dir, "open.log"),
	};
	const fixtures = {
		panes: join(dir, "panes.json"),
		browsers: join(dir, "browsers.json"),
		tabs: join(dir, "tabs.txt"),
	};
	mkdirSync(home, { recursive: true });
	writeFileSync(fixtures.panes, '{"result":{"panes":[]}}\n');
	writeFileSync(fixtures.browsers, '{"self":null,"browsers":[]}\n');
	writeFileSync(fixtures.tabs, "");

	const launchServices = join(home, "Library", "Preferences", "com.apple.LaunchServices");
	mkdirSync(launchServices, { recursive: true });
	mkdirSync(bin, { recursive: true });

	stub(join(bin, "herdr"), logs.herdr, `case "$1 $2" in "pane list") cat '${fixtures.panes}' ;; esac\nexit 0`);
	stub(join(bin, "terminal-browser"), logs.terminalBrowser, `case "$1" in ls) cat '${fixtures.browsers}' ;; esac\nexit 0`);
	stub(join(bin, "osascript"), logs.osascript, `case "$3" in list) cat '${fixtures.tabs}' ;; esac\nexit 0`);
	stub(join(bin, "open"), logs.open, "exit 0");

	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
	// This run may itself be in a herdr pane; the test's own stand-ins are the pane it clicks in.
	for (const name of Object.keys(env)) if (name.startsWith("HERDR_")) delete env[name];
	env.HERDR_PANE_ID = "wA:p1";
	env.HERDR_WORKSPACE_ID = "wA";
	// Asynchronous, so the stand-in board keeps answering while the click runs.
	const click = (url: string) =>
		new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = spawn("bash", [join(plugin, "board.sh")], {
				cwd: home,
				env: { ...env, HERDR_PLUGIN_CLICKED_URL: url },
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
			child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
			child.on("close", (status) => resolve({ status, stdout, stderr }));
		});
	const setDefaultBrowser = (bundleId: string) =>
		writeFileSync(
			join(launchServices, "com.apple.launchservices.secure.plist"),
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>LSHandlers</key><array><dict>
<key>LSHandlerURLScheme</key><string>https</string>
<key>LSHandlerRoleAll</key><string>${bundleId}</string>
</dict></array></dict></plist>
`,
		);
	const herdrPanes = (panes: string[]) =>
		writeFileSync(fixtures.panes, `${JSON.stringify({ result: { panes: panes.map((pane_id) => ({ pane_id, workspace_id: pane_id.split(":")[0] })) } })}\n`);
	const terminalBrowsers = (browsers: unknown[]) => writeFileSync(fixtures.browsers, `${JSON.stringify({ self: null, browsers })}\n`);
	const browserTabs = (lines: string[]) => writeFileSync(fixtures.tabs, lines.map((line) => `${line}\n`).join(""));
	return { home, logs, click, setDefaultBrowser, herdrPanes, terminalBrowsers, browserTabs };
};

/** The calls a stand-in was given, one array of arguments per call; a log never written is no calls. */
const calls = (path: string): string[][] => {
	if (!existsSync(path)) return [];
	const blocks: string[][] = [];
	let current: string[] | undefined;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line === "---") {
			current = [];
			blocks.push(current);
		} else if (line !== "" && current) current.push(line);
	}
	return blocks;
};

/** The board's messages: the click switched the server to the link's project, and to nothing else. */
const assertBoardSwitched = (board: Board, repo: string) =>
	assert.deepEqual(
		board.messages.map((message) => [message.type, message.payload.path]),
		[["set-workspace", repo]],
		"the board server is switched to the link's project",
	);

/** The script a tab was given: it saves the project, then moves the page to the Bead. */
const assertPageShowsBead = (script: string, repo: string, issue: string) => {
	assert.ok(script.includes(`"beads-ui.workspace", "${repo}"`), script);
	const beadPage = `#/board?issue=${issue}`;
	assert.ok(script.includes(beadPage), script);
	assert.ok(
		script.indexOf("beads-ui.workspace") < script.indexOf(beadPage),
		"the project is saved before the page moves to the Bead",
	);
};

/** One click against a stand-in board and a temporary Mac, both cleaned up whatever the click did. */
const withBoardAndMac = async (run: (board: Board, mac: Machine) => Promise<void>) => {
	const board = await boardStub();
	const mac = makeMachine();
	try {
		await run(board, mac);
	} finally {
		await board.close();
		rmSync(dirname(mac.home), { recursive: true, force: true });
	}
};

test("a board link switches the board to the link's project and shows the Bead in the board's terminal-browser pane in this herdr workspace", () =>
	withBoardAndMac(async (board, mac) => {
		const repo = "/Users/thehuman/Developer/personal_code/factory";
		mac.herdrPanes(["wA:p1", "wA:p3", "wB:p1"]);
		mac.terminalBrowsers([
			{
				key: "90107-1",
				pane: { tab: "wA:t1", pane: "wA:p3" },
				tabs: [
					{ id: "1", url: "http://127.0.0.1:3917/#/issues?issue=fac-qpv.6.3", active: false },
					{ id: "2", url: `${board.base}#/board?issue=fac-qpv.6.3`, active: true },
				],
			},
		]);

		const result = await mac.click(boardLink(board.port, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		assertBoardSwitched(board, repo);
		assert.deepEqual(calls(mac.logs.herdr), [["pane", "list", "--workspace", "wA"]], "herdr is asked which panes this workspace has");
		const shown = calls(mac.logs.terminalBrowser).find((call) => call[0] === "action");
		assert.ok(shown, "the board's tab is told to show the Bead");
		assert.deepEqual(shown.slice(0, 7), ["action", "--browser", "90107-1", "--tab", "2", "--follow", "--"], "the board's tab in this workspace is shown");
		assert.equal(shown[7], "eval");
		assertPageShowsBead(shown[8], repo, "fac-qpv.7.2");
		assert.deepEqual(calls(mac.logs.osascript), [], "no browser was asked for a tab");
	}));

test("a board in another herdr workspace is left alone, and the default browser's board tab is shown instead", () =>
	withBoardAndMac(async (board, mac) => {
		const repo = "/Users/thehuman/Developer/personal_code/news";
		mac.setDefaultBrowser("com.apple.safari");
		mac.herdrPanes(["wA:p1", "wA:p3"]);
		mac.terminalBrowsers([
			{ key: "90107-1", pane: { tab: "wB:t1", pane: "wB:p3" }, tabs: [{ id: "2", url: `${board.base}#/board?issue=fac-qpv.6.3`, active: true }] },
		]);
		mac.browserTabs(["2\t3\t" + board.base + "#/board?issue=fac-qpv.6.3", "2\t4\thttps://example.com/"]);

		const result = await mac.click(boardLink(board.port, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		assertBoardSwitched(board, repo);
		assert.deepEqual(
			calls(mac.logs.terminalBrowser).filter((call) => call[0] === "action"),
			[],
			"the browser showing the board in another workspace is left alone",
		);
		const asked = calls(mac.logs.osascript);
		assert.deepEqual(asked.map((call) => call.slice(1, 3)), [["Safari", "list"], ["Safari", "run"]], "Safari's tabs are listed, then the board tab is shown in");
		assert.equal(asked[0].length, 3, "the browser lists every tab, and the click picks the board's");
		assert.deepEqual(asked[1].slice(3, 5), ["2", "3"], "the board tab's window and tab are the ones shown in");
		assertPageShowsBead(asked[1][5], repo, "fac-qpv.7.2");
		assert.deepEqual(calls(mac.logs.open), [], "no new tab is opened");
	}));

test("with no board tab open, the click opens a new tab in the default browser and shows the Bead in it", () =>
	withBoardAndMac(async (board, mac) => {
		const repo = "/Users/thehuman/Developer/personal_code/beads-ui";
		mac.setDefaultBrowser("com.google.chrome");
		mac.herdrPanes(["wA:p1"]);
		mac.browserTabs(["1\t1\thttps://example.com/"]);
		mac.terminalBrowsers([]);

		const result = await mac.click(boardLink(board.port, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		const asked = calls(mac.logs.osascript);
		assert.deepEqual(
			asked.map((call) => [call[1], call[2]]),
			[["Google Chrome", "list"], ["Google Chrome", "open"]],
			"the default browser's tabs are listed, then a tab is opened in it",
		);
		assert.equal(asked[1][3], board.base, "the new tab starts at the board's own address");
		assertPageShowsBead(asked[1][4], repo, "fac-qpv.7.2");
		assert.deepEqual(calls(mac.logs.open), [], "the browser opens the tab itself, so no second tab is opened");
	}));

test("a default browser this plugin cannot run script in gets the link in a new tab", () =>
	withBoardAndMac(async (board, mac) => {
		const repo = "/Users/thehuman/Developer/personal_code/factory";
		mac.setDefaultBrowser("org.mozilla.firefox");
		mac.herdrPanes(["wA:p1"]);
		mac.terminalBrowsers([]);

		const result = await mac.click(boardLink(board.port, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		assert.deepEqual(calls(mac.logs.osascript), [], "no browser is scripted");
		assert.deepEqual(calls(mac.logs.open), [[boardLink(board.port, "fac-qpv.7.2", repo)]], "the link is opened as it is");
		assertBoardSwitched(board, repo);
	}));
