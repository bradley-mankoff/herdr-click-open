/**
 * The click-open herdr plugin (`fac-qpv.7.2`): Ctrl-clicking a Bead link on the board shows
 * that Bead in a terminal-browser pane of the clicked pane's herdr workspace, switching the
 * board to the link's project first. With no board pane in that workspace, the click splits
 * the clicked pane and opens terminal-browser there, the way open.sh opens a web link.
 *
 * The seam is the plugin's board action, run the way herdr runs it: `bash board.sh` in a
 * herdr pane, with the clicked link in `HERDR_PLUGIN_CLICKED_URL`. herdr, terminal-browser,
 * the Mac's `open` and the board's websocket server are stand-ins at those edges, each
 * writing down how it was called; the tests read those logs instead of looking inside the
 * script.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

type Logs = { herdr: string; terminalBrowser: string; open: string };

type Machine = {
	home: string;
	logs: Logs;
	/** A project folder in this temporary Mac, by default with a Beads database in it. */
	project: (name: string, options?: { beads?: boolean }) => string;
	click: (url: string) => Promise<{ status: number | null; stdout: string; stderr: string }>;
	/** What `herdr pane list` prints: the panes of the clicked pane's workspace. */
	herdrPanes: (panes: string[]) => void;
	/** What `terminal-browser ls --all --json` prints. */
	terminalBrowsers: (browsers: unknown[]) => void;
	/** The pane `herdr pane split` opens. */
	splitPane: (paneId: string) => void;
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

/** One temporary Mac: project folders, and stand-ins for herdr and terminal-browser on PATH. */
const makeMachine = (): Machine => {
	const dir = mkdtempSync(join(tmpdir(), "factory-click-open-"));
	const home = join(dir, "home");
	// The plugin prepends $HOME/.local/bin, where herdr loads the tools it runs, to PATH.
	const bin = join(home, ".local", "bin");
	const logs: Logs = {
		herdr: join(dir, "herdr.log"),
		terminalBrowser: join(dir, "terminal-browser.log"),
		open: join(dir, "open.log"),
	};
	const fixtures = {
		panes: join(dir, "panes.json"),
		browsers: join(dir, "browsers.json"),
		pane: join(dir, "pane.json"),
	};
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(fixtures.panes, '{"result":{"panes":[]}}\n');
	writeFileSync(fixtures.browsers, '{"self":null,"browsers":[]}\n');
	writeFileSync(fixtures.pane, '{"result":{"pane":{"pane_id":"wA:p9"}}}\n');

	// The herdr stand-in: `pane list` and `pane split` answer from fixtures, and `pane run`
	// leaves the browser it starts behind for `terminal-browser ls`.
	stub(
		join(bin, "herdr"),
		logs.herdr,
		`case "$1 $2" in
"pane list") cat '${fixtures.panes}' ;;
"pane split") cat '${fixtures.pane}' ;;
"pane run")
	# The command's last word is the address terminal-browser opens, so the browser it starts
	# answers terminal-browser's own listing from then on.
	printf '{"self":null,"browsers":[{"key":"90109-1","pane":{"tab":"wA:t9","pane":"%s"},"tabs":[{"id":"7","url":"%s","active":true}]}]}\\n' "$3" "\${4##* }" > '${fixtures.browsers}'
	;;
esac
exit 0`,
	);
	stub(join(bin, "terminal-browser"), logs.terminalBrowser, `case "$1" in ls) cat '${fixtures.browsers}' ;; esac\nexit 0`);
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
	const project = (name: string, { beads = true } = {}) => {
		const path = join(dir, name);
		mkdirSync(beads ? join(path, ".beads") : path, { recursive: true });
		return path;
	};
	const herdrPanes = (panes: string[]) =>
		writeFileSync(fixtures.panes, `${JSON.stringify({ result: { panes: panes.map((pane_id) => ({ pane_id, workspace_id: pane_id.split(":")[0] })) } })}\n`);
	const terminalBrowsers = (browsers: unknown[]) => writeFileSync(fixtures.browsers, `${JSON.stringify({ self: null, browsers })}\n`);
	const splitPane = (paneId: string) => writeFileSync(fixtures.pane, `${JSON.stringify({ result: { pane: { pane_id: paneId } } })}\n`);
	return { home, logs, project, click, herdrPanes, terminalBrowsers, splitPane };
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

/** The tab the click chose is the one told to show the Bead, and no default browser is asked. */
const assertShownInTab = (mac: Machine, browser: string, tab: string, repo: string) => {
	const shown = calls(mac.logs.terminalBrowser).find((call) => call[0] === "action");
	assert.ok(shown, "a terminal-browser tab is told to show the Bead");
	assert.deepEqual(
		shown.slice(0, 7),
		["action", "--browser", browser, "--tab", tab, "--follow", "--"],
		"the tab the click chose is shown the Bead",
	);
	assert.equal(shown[7], "eval");
	assertPageShowsBead(shown[8], repo, "fac-qpv.7.2");
	assert.deepEqual(calls(mac.logs.open), [], "no default-browser tab is opened");
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
		const repo = mac.project("factory");
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
			{
				key: "90107-2",
				pane: { tab: "wB:t1", pane: "wB:p3" },
				tabs: [{ id: "1", url: `${board.base}#/board?issue=fac-qpv.6.3`, active: true }],
			},
		]);

		const result = await mac.click(boardLink(board.port, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		assertBoardSwitched(board, repo);
		assert.deepEqual(calls(mac.logs.herdr), [["pane", "list", "--workspace", "wA"]], "herdr is asked which panes this workspace has");
		assertShownInTab(mac, "90107-1", "2", repo);
	}));

test("with no board tab in this herdr workspace, the click splits the clicked pane to the right and opens terminal-browser there, then shows the Bead", () =>
	withBoardAndMac(async (board, mac) => {
		const repo = mac.project("factory");
		mac.herdrPanes(["wA:p1", "wA:p3"]);
		mac.splitPane("wA:p9");
		mac.terminalBrowsers([
			{
				key: "90107-1",
				pane: { tab: "wB:t1", pane: "wB:p3" },
				tabs: [{ id: "2", url: `${board.base}#/board?issue=fac-qpv.6.3`, active: true }],
			},
		]);

		const result = await mac.click(boardLink(board.port, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		assertBoardSwitched(board, repo);
		assert.deepEqual(
			calls(mac.logs.herdr),
			[
				["pane", "list", "--workspace", "wA"],
				["pane", "split", "--pane", "wA:p1", "--direction", "right", "--focus"],
				["pane", "run", "wA:p9", `exec terminal-browser open ${board.base}`],
			],
			"the clicked pane is split to the right and terminal-browser opens there",
		);
		assertShownInTab(mac, "90109-1", "7", repo);
	}));

test("a board link to a project with no .beads folder is refused, and the board is left where it was", () =>
	withBoardAndMac(async (board, mac) => {
		const repo = mac.project("news", { beads: false });
		mac.herdrPanes(["wA:p1"]);

		const result = await mac.click(boardLink(board.port, "fac-qpv.7.2", repo));
		assert.notEqual(result.status, 0, "the click reports the missing database");
		assert.match(result.stderr, /\.beads/, "the message names the missing .beads folder");
		assert.ok(result.stderr.includes(repo), `the message names the project: ${result.stderr}`);
		assert.deepEqual(board.messages, [], "the board is not switched to a folder with no database");
		assert.deepEqual(calls(mac.logs.herdr), [], "no board pane is opened");
		assert.deepEqual(calls(mac.logs.terminalBrowser), [], "no browser is opened there");
	}));
