/**
 * The click-open herdr plugin's board action (herdr-click-open-0h4): Ctrl-clicking a board
 * link splits the clicked pane to the right and opens micro on that Bead's content, rendered
 * by `bd show` in the link's project. The pane shows a temporary copy, so no edit reaches the
 * Bead, and neither the board, terminal-browser, the default browser nor AppleScript takes
 * part.
 *
 * The seam is the plugin's board action, run the way herdr runs it: `bash board.sh` in a
 * herdr pane, with the clicked link in `HERDR_PLUGIN_CLICKED_URL`. herdr, bd and micro are
 * stand-ins at those edges, each writing down how it was called; the tools that must not
 * take part are stand-ins too, so their logs show a call that never happened. The tests read
 * those logs and the content micro was handed, not the script's internals.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The link bead-links.ts writes in a Project Manager's reply. */
const boardLink = (port: number, issue: string, repo: string): string =>
	`http://127.0.0.1:${port}/#/board?issue=${encodeURIComponent(issue)}&workspace=${encodeURIComponent(repo)}`;

type Logs = {
	herdr: string;
	bd: string;
	bdCwd: string;
	micro: string;
	terminalBrowser: string;
	open: string;
	osascript: string;
};

type Machine = {
	home: string;
	/** This temporary Mac's TMPDIR, where a clicked link's temporary file belongs. */
	temp: string;
	logs: Logs;
	/** A project folder in this temporary Mac. */
	project: (name: string) => string;
	/** `bd show` fails, as it does in a folder with no Beads database. */
	failBd: () => void;
	click: (url: string) => Promise<{ status: number | null; stdout: string; stderr: string }>;
	/** The temp files the click left in this machine's TMPDIR. */
	temps: () => string[];
	/** The content micro was handed, one block per micro call. */
	shown: () => string[];
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

/** One temporary Mac: project folders, and stand-ins for herdr, bd, micro and the rest. */
const makeMachine = (): Machine => {
	const dir = mkdtempSync(join(tmpdir(), "factory-click-open-"));
	const home = join(dir, "home");
	// The plugin prepends $HOME/.local/bin, where herdr loads the tools it runs, to PATH.
	const bin = join(home, ".local", "bin");
	const temp = join(dir, "tmp");
	const logs: Logs = {
		herdr: join(dir, "herdr.log"),
		bd: join(dir, "bd.log"),
		bdCwd: join(dir, "bd-cwd.log"),
		micro: join(dir, "micro.log"),
		terminalBrowser: join(dir, "terminal-browser.log"),
		open: join(dir, "open.log"),
		osascript: join(dir, "osascript.log"),
	};
	const fixtures = {
		splits: join(dir, "splits"),
		bdFails: join(dir, "bd-fails"),
		shown: join(dir, "micro-shown"),
	};
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	mkdirSync(temp, { recursive: true });
	writeFileSync(fixtures.splits, "0\n");

	// The herdr stand-in: each split opens the next pane, and `pane run` runs the command in
	// it, the way a pane would.
	stub(
		join(bin, "herdr"),
		logs.herdr,
		`case "$1 $2" in
"pane split")
	n=$(cat '${fixtures.splits}')
	n=$((n + 1))
	printf '%s\\n' "$n" > '${fixtures.splits}'
	printf '{"result":{"pane":{"pane_id":"wA:p%d"}}}\\n' "$((n + 8))"
	;;
"pane run") eval "$4" ;;
esac
exit 0`,
	);

	// The bd stand-in: it says which project it ran in and how the Bead was asked for, and
	// renders known content when it succeeds.
	stub(
		join(bin, "bd"),
		logs.bd,
		`printf '%s\\n' "$PWD" >> '${logs.bdCwd}'
if [ -f '${fixtures.bdFails}' ]; then
	echo 'Error: no beads database found' >&2
	exit 1
fi
printf 'bead %s\\nproject %s\\n' "$2" "$PWD"`,
	);

	// The micro stand-in: it keeps the content it was handed, so an edit after it opened the
	// file cannot hide what the pane first showed.
	stub(
		join(bin, "micro"),
		logs.micro,
		`for last; do :; done
printf '%s\\n' ---SHOWN--- >> '${fixtures.shown}'
cat -- "$last" >> '${fixtures.shown}'`,
	);

	for (const [name, log] of [
		["terminal-browser", logs.terminalBrowser],
		["open", logs.open],
		["osascript", logs.osascript],
	] as const) {
		stub(join(bin, name), log, "exit 0");
	}

	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: temp };
	// This run may itself be in a herdr pane; the test's own stand-ins are the pane it clicks in.
	for (const name of Object.keys(env)) if (name.startsWith("HERDR_")) delete env[name];
	env.HERDR_PANE_ID = "wA:p1";
	env.HERDR_WORKSPACE_ID = "wA";
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
	const project = (name: string) => {
		const path = join(dir, name);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const failBd = () => writeFileSync(fixtures.bdFails, "");
	const temps = () => readdirSync(temp);
	const shown = () =>
		existsSync(fixtures.shown) ? readFileSync(fixtures.shown, "utf8").split("---SHOWN---\n").slice(1) : [];
	return { home, temp, logs, project, failBd, click, temps, shown };
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

/** The projects bd was run in, in call order. */
const bdProjects = (mac: Machine): string[] =>
	existsSync(mac.logs.bdCwd) ? readFileSync(mac.logs.bdCwd, "utf8").trim().split("\n") : [];

/** The temporary file a pane's micro command opened. */
const pageOf = (run: string[]): string => {
	const command = run[3];
	assert.match(command, /^exec micro -readonly true /, `the pane runs micro read-only: ${command}`);
	return command.slice(command.lastIndexOf(" ") + 1);
};

/** The temporary file holds bd's rendering of this Bead in this project. */
const assertShowsBead = (mac: Machine, page: string, issue: string, repo: string) => {
	assert.ok(page.startsWith(`${mac.temp}/`), `the Bead is rendered to a temporary file: ${page}`);
	assert.ok(!page.startsWith(`${repo}/`), "the temporary file is outside the project, so an edit cannot write back to the Bead");
	assert.deepEqual(mac.shown(), [`bead ${issue}\nproject ${repo}\n`], "micro shows bd's rendering of the link's Bead in the link's project");
};

/** One click against a temporary Mac, cleaned up whatever the click did. */
const withMachine = async (run: (mac: Machine) => Promise<void>) => {
	const mac = makeMachine();
	try {
		await run(mac);
	} finally {
		rmSync(dirname(mac.home), { recursive: true, force: true });
	}
};

/** A board whose page and socket both fail, so a click that still asks it would show the error. */
async function failingBoard() {
	let requests = 0;
	let connections = 0;
	const server = createServer((_request, response) => {
		requests += 1;
		response.writeHead(500);
		response.end();
	});
	server.on("upgrade", (_request, socket) => {
		connections += 1;
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		port,
		requests: () => requests,
		connections: () => connections,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

test("a board link splits the clicked pane to the right and opens micro on the Bead bd show renders in the link's project", () =>
	withMachine(async (mac) => {
		const repo = mac.project("factory");

		const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		const herdr = calls(mac.logs.herdr);
		assert.deepEqual(
			herdr[0],
			["pane", "split", "--pane", "wA:p1", "--direction", "right", "--focus"],
			"the clicked pane is split to the right",
		);
		assert.equal(herdr.length, 2, "the click splits once and runs one command");
		assert.deepEqual(herdr[1].slice(0, 3), ["pane", "run", "wA:p9"], "micro runs in the pane the split opened");

		assert.deepEqual(calls(mac.logs.bd), [["show", "fac-qpv.7.2"]], "bd show is asked for the link's Bead");
		assert.deepEqual(bdProjects(mac), [repo], "bd runs in the link's project");
		assertShowsBead(mac, pageOf(herdr[1]), "fac-qpv.7.2", repo);
	}));

test("a board link opens the Bead without the board, terminal-browser, the default browser or AppleScript, even when the board would fail", async () => {
	const board = await failingBoard();
	const mac = makeMachine();
	try {
		const repo = mac.project("factory");

		const result = await mac.click(boardLink(board.port, "fac-qpv.7.2", repo));
		assert.equal(result.status, 0, result.stderr);

		assert.equal(calls(mac.logs.micro).length, 1, "micro opens the Bead");
		assert.equal(board.requests(), 0, "no board page is asked for");
		assert.equal(board.connections(), 0, "the board's socket is never opened");
		assert.deepEqual(calls(mac.logs.terminalBrowser), [], "terminal-browser is not involved");
		assert.deepEqual(calls(mac.logs.open), [], "no default-browser tab is opened");
		assert.deepEqual(calls(mac.logs.osascript), [], "no AppleScript runs");
	} finally {
		await board.close();
		rmSync(dirname(mac.home), { recursive: true, force: true });
	}
});

test("a second Ctrl-click opens another pane, with that link's Bead in that link's project", () =>
	withMachine(async (mac) => {
		const factory = mac.project("factory");
		const personal = mac.project("personal");

		const first = await mac.click(boardLink(3917, "fac-qpv.7.2", factory));
		assert.equal(first.status, 0, first.stderr);
		const second = await mac.click(boardLink(3918, "herdr-click-open-0h4", personal));
		assert.equal(second.status, 0, second.stderr);

		const herdr = calls(mac.logs.herdr);
		const splits = herdr.filter((call) => call[1] === "split");
		const runs = herdr.filter((call) => call[1] === "run");
		assert.equal(splits.length, 2, "each click splits the clicked pane");
		assert.deepEqual(
			runs.map((run) => run[2]),
			["wA:p9", "wA:p10"],
			"each click opens its own pane",
		);
		assert.deepEqual(bdProjects(mac), [factory, personal], "each click reads the Bead in its own link's project");
		assert.deepEqual(
			mac.shown(),
			[
				`bead fac-qpv.7.2\nproject ${factory}\n`,
				`bead herdr-click-open-0h4\nproject ${personal}\n`,
			],
			"the first pane still shows the first Bead, and the second its own",
		);
		for (const page of runs.map(pageOf)) {
			assert.ok(page.startsWith(`${mac.temp}/`), `each Bead is rendered to a temporary file: ${page}`);
		}
	}));

test("a board link whose Bead bd cannot show opens no pane, and the click says why", () =>
	withMachine(async (mac) => {
		const repo = mac.project("factory");
		mac.failBd();

		const result = await mac.click(boardLink(3917, "fac-qpv.7.2", repo));
		assert.notEqual(result.status, 0, "the click reports the failure");
		assert.match(result.stderr, /no beads database found/, "the message says what bd said");
		assert.deepEqual(calls(mac.logs.herdr), [], "no pane is opened for a Bead that could not be shown");
		assert.deepEqual(calls(mac.logs.micro), [], "micro is not started");
		assert.deepEqual(mac.temps(), [], "the temporary file is cleaned up");
	}));
